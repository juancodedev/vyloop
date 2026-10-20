import { and, eq, isNotNull, like, or } from 'drizzle-orm';

import { DEFAULT_GEOHASH_PRECISION, decodeGeohash, encodeGeohash } from './geohash';
import { branches } from './schema';

// ---------------------------------------------------------------------------
// Proximity.
//
// "Which venues are near this point?" is answered in two stages, and the two
// stages exist because they fail in different ways:
//
//   1. **The coarse stage: a geohash prefix.** The branch's geohash is stored
//      at the default precision, so a prefix match is a range scan over the
//      `idx_branches_geohash` index rather than a scan of every venue in the
//      system. The prefix is the *cell* the centre point falls in, and the
//      cell's eight neighbours: a venue 900 m from the edge of the disc is in
//      the cell next door, not in the cell the caller pointed at.
//
//   2. **The fine stage: the exact distance.** The cells are wide, so they
//      contain venues that are not close enough. The haversine distance in
//      metres against the radius removes them.
//
// The order matters, and the reason is a guarantee rather than an
// optimisation: **a venue inside the radius is never missed.** The coarse stage
// is the only thing standing between the query and the venue, and a venue
// whose cell is not in the computed set never reaches the fine stage at all.
// So the computed cells have to cover the whole disc, and that is a property
// this module is built to hold rather than to hope for.
//
// ## The cell dimension table
//
// A geohash cell at precision `p` is a rectangle. Each character adds five
// bits, longitude first, so the longitude gets `ceil(5p/2)` halvings and the
// latitude `floor(5p/2)`:
//
//   | precision | longitude | latitude  | longitude at the equator | latitude |
//   |-----------|-----------|-----------|-------------------------|----------|
//   | 1         | 45°       | 45°       | 5 009 km                | 4 976 km |
//   | 2         | 11.25°    | 5.625°    | 1 252 km                | 622 km   |
//   | 3         | 1.40625°  | 1.40625°  | 156.5 km                | 155.5 km |
//   | 4         | 0.3515625°| 0.1757813°| 39.1 km                 | 19.4 km  |
//   | 5         | 0.0439453°| 0.0439453°| 4.89 km                 | 4.86 km  |
//   | 6         | 0.0109863°| 0.0054932°| 1.223 km                | 607 m    |
//   | 7         | 0.0013733°| 0.0013733°| 153 m                   | 152 m    |
//
// Precision 6 is the default a venue is stored at, and it is the cell the
// product documentation calls "roughly 1.2 km × 0.6 km".
//
// ## How a radius picks a precision
//
// The centre point lies somewhere inside its own cell, and the nine cells —
// that one and its eight neighbours — reach **one full cell** beyond it in
// every direction, whatever position inside the cell the point occupies. A
// disc of radius `r` is therefore covered by the nine cells when one cell's
// extent is at least `r` in both directions.
//
// Walking the precisions from the finest down and taking the first that
// covers the disc gives the most selective filter that still holds the
// guarantee:
//
//   | radius      | precision | why                                        |
//   |-------------|-----------|--------------------------------------------|
//   | ≤ 607 m     | 6         | the default cell is already wide enough      |
//   | ≤ 4.86 km   | 5         |                                            |
//   | ≤ 19.4 km   | 4         |                                            |
//   | ≤ 50 km     | 3         | and 3 is what the 50 km cap lands on        |
//
// The precision is never finer than `DEFAULT_GEOHASH_PRECISION`: a venue
// stores a geohash of that many characters, so a longer prefix could never
// match a stored row and the venue would be invisible rather than merely
// imprecise.
//
// ## The longitude margin shrinks with the latitude
//
// A degree of longitude is shorter the closer the venue is to a pole, so the
// coverage rule measures the longitude margin at the latitude furthest from
// the equator that the disc reaches. A rule that measured it at the centre
// would lose venues in Reykjavik and keep every venue in Lima.
// ---------------------------------------------------------------------------

/** A point on the globe, in decimal degrees. */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * The mean earth radius, in metres.
 *
 * The IUGG mean radius, which is the same one the haversine formula is
 * written against. It is a single constant on purpose: the distance function
 * and the cell-coverage rule have to agree about how long a degree is, or
 * the coverage guarantee is computed against a different planet from the one
 * the distances are measured on.
 */
const EARTH_RADIUS_METERS = 6371008.8;

/** Metres per degree of latitude on that sphere. */
const METERS_PER_DEGREE = (Math.PI * EARTH_RADIUS_METERS) / 180;

/** The shortest prefix this module ever asks for. */
const MIN_CELL_PRECISION = 1;

/**
 * The longest prefix this module ever asks for.
 *
 * The default precision, because that is how long a venue's stored geohash
 * is. A longer prefix would match no stored row at all.
 */
const MAX_CELL_PRECISION = DEFAULT_GEOHASH_PRECISION;

/**
 * The distance between two points, in metres.
 *
 * The haversine formula on a sphere: the angle at the centre of the earth
 * between the two positions, times the radius. It is the same formula the
 * cell coverage rule is derived from, so the two cannot disagree about what
 * a metre is.
 *
 * The distance is computed on the decimal degrees, never on the geohash: a
 * geohash is a lossy encoding of about a kilometre, and a distance read off
 * one would be an answer to a different question.
 */
export function haversineDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

  const deltaLatitude = toRadians(b.latitude - a.latitude);
  const deltaLongitude = toRadians(b.longitude - a.longitude);

  const sinLatitude = Math.sin(deltaLatitude / 2);
  const sinLongitude = Math.sin(deltaLongitude / 2);

  const haversine =
    sinLatitude * sinLatitude +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * sinLongitude * sinLongitude;

  // `asin` is only defined on [-1, 1], and floating point can push the
  // argument a hair past the end when the two points are the same one.
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

/**
 * The size of one geohash cell, in degrees, at a given precision.
 *
 * Derived from the encoding rather than tabulated: each character adds five
 * bits, longitude on the even ones, so the longitude is halved `ceil(5p/2)`
 * times and the latitude `floor(5p/2)` times.
 */
export function geohashCellDegrees(precision: number): { longitude: number; latitude: number } {
  const longitudeBits = Math.ceil((5 * precision) / 2);
  const latitudeBits = Math.floor((5 * precision) / 2);

  return {
    longitude: 360 / 2 ** longitudeBits,
    latitude: 180 / 2 ** latitudeBits,
  };
}

/**
 * Do the cell of this precision and its eight neighbours cover the disc?
 *
 * The nine cells reach one full cell beyond the centre point in every
 * direction, so the guarantee is one cell's extent against the radius. The
 * longitude extent is measured at the latitude furthest from the equator the
 * disc reaches, because that is where a degree of longitude is shortest.
 */
function cellsCoverDisc(
  latitude: number,
  longitude: number,
  radiusMeters: number,
  precision: number,
): boolean {
  const cell = geohashCellDegrees(precision);

  const latitudeSpan = radiusMeters / METERS_PER_DEGREE;
  const furthestLatitude = Math.max(
    Math.abs(latitude + latitudeSpan),
    Math.abs(latitude - latitudeSpan),
  );
  const longitudeMargin =
    cell.longitude * METERS_PER_DEGREE * Math.cos((furthestLatitude * Math.PI) / 180);
  const latitudeMargin = cell.latitude * METERS_PER_DEGREE;

  return longitudeMargin >= radiusMeters && latitudeMargin >= radiusMeters;
}

/**
 * The geohash precision whose cell — with its eight neighbours — covers a
 * disc of the given radius.
 *
 * The most selective precision that still covers the disc, and never finer
 * than the precision a venue is stored at. See the table in the module header
 * for the values this returns.
 */
export function geohashPrecisionForRadius(
  latitude: number,
  longitude: number,
  radiusMeters: number,
): number {
  for (let precision = MAX_CELL_PRECISION; precision >= MIN_CELL_PRECISION; precision -= 1) {
    if (cellsCoverDisc(latitude, longitude, radiusMeters, precision)) {
      return precision;
    }
  }

  // Only reachable for a radius larger than a precision-1 cell, which no
  // product surface asks for. The coarsest cell is the best that can be done
  // anyway: it is the largest one there is.
  return MIN_CELL_PRECISION;
}

/**
 * The geohash cells that can hold a point inside a disc.
 *
 * The cell the centre falls in and its eight neighbours, at the precision
 * that covers the radius. Every point of the disc is in one of them, which is
 * the guarantee the query's coarse filter rests on.
 *
 * At the poles and across the antimeridian the shifted cell centres are
 * clamped onto the globe, so the set can hold fewer than nine cells. That is
 * correct rather than lossy: outside the range there is no cell to name.
 */
export function geohashCellsForRadius(
  latitude: number,
  longitude: number,
  radiusMeters: number,
): string[] {
  const precision = geohashPrecisionForRadius(latitude, longitude, radiusMeters);
  const centre = decodeGeohash(encodeGeohash(latitude, longitude, precision));
  const cell = geohashCellDegrees(precision);

  const cells = new Set<string>();

  for (const latitudeStep of [-1, 0, 1]) {
    for (const longitudeStep of [-1, 0, 1]) {
      const cellLatitude = clamp(centre.latitude + latitudeStep * cell.latitude, -90, 90);
      const cellLongitude = clamp(centre.longitude + longitudeStep * cell.longitude, -180, 180);

      cells.add(encodeGeohash(cellLatitude, cellLongitude, precision));
    }
  }

  return [...cells].sort();
}

/** A branch, as the proximity query returns it. */
export interface BranchInRadius {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** The exact distance from the centre of the search. */
  distanceMeters: number;
}

/** Which branches, of which tenant, within which radius. */
export interface BranchRadiusScope {
  businessId: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

/** A branch row, as the database holds it. */
interface BranchRow {
  id: string;
  name: string;
  businessId: string;
  /** `numeric(9,6)`, so it arrives as a string. */
  latitude: string | null;
  longitude: string | null;
}

/**
 * The branches of a tenant that are inside a radius.
 *
 * The two stages, in order: the geohash prefix is the coarse filter and runs
 * in the database against the index; the exact distance is the fine filter and
 * runs here, because a distance function over `numeric` columns is not
 * something to ask the index for.
 *
 * Three things are excluded, and each of them is a rule rather than an
 * accident:
 *
 *   - **A branch of another tenant.** The query is scoped by `business_id`,
 *     and the scope is checked again here so the exclusion holds even if the
 *     row came back from a query that was not scoped.
 *   - **A branch without a position.** `latitude` and `longitude` are
 *     nullable, and `NULL` means "this venue has not registered a position".
 *     It is not "in every radius".
 *   - **A branch outside the radius.** It is in one of the cells, and it is
 *     still too far away.
 */
export async function findBranchesInRadius(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  scope: BranchRadiusScope,
): Promise<BranchInRadius[]> {
  const cells = geohashCellsForRadius(scope.latitude, scope.longitude, scope.radiusMeters);

  const rows = await db
    .select({
      id: branches.id,
      name: branches.name,
      businessId: branches.businessId,
      latitude: branches.latitude,
      longitude: branches.longitude,
    })
    .from(branches)
    .where(
      and(
        eq(branches.businessId, scope.businessId),
        isNotNull(branches.latitude),
        isNotNull(branches.longitude),
        // The coarse stage. `geohash` is the cached position, so a prefix
        // match is a range scan over `idx_branches_geohash`.
        or(...cells.map((cell) => like(branches.geohash, `${cell}%`))),
      ),
    );

  const centre: GeoPoint = { latitude: scope.latitude, longitude: scope.longitude };
  const found: BranchInRadius[] = [];

  for (const row of rows as BranchRow[]) {
    if (row.businessId !== scope.businessId) {
      continue;
    }

    if (row.latitude === null || row.longitude === null) {
      continue;
    }

    // `numeric` is read as a string, and arithmetic on a string is the wrong
    // arithmetic.
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue;
    }

    const distanceMeters = haversineDistanceMeters(centre, { latitude, longitude });
    if (distanceMeters > scope.radiusMeters) {
      continue;
    }

    found.push({ id: row.id, name: row.name, latitude, longitude, distanceMeters });
  }

  // Nearest first: a caller that shows a list of nearby venues shows the
  // closest one at the top.
  found.sort((a, b) => a.distanceMeters - b.distanceMeters);

  return found;
}

/** Hold a value inside a range. */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
