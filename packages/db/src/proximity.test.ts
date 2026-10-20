import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { encodeGeohash } from './geohash';
import {
  findBranchesInRadius,
  geohashCellsForRadius,
  geohashPrecisionForRadius,
  haversineDistanceMeters,
} from './proximity';

// ---------------------------------------------------------------------------
// The proximity geometry.
//
// Two properties matter here and only two:
//
//   1. **A venue inside the radius is never missed.** The geohash stage is a
//      coarse filter over a prefix index, so a venue whose geohash falls
//      outside the computed cells is invisible to the query — and the exact
//      distance filter, which runs afterwards, never sees it. The guarantee is
//      therefore a property of the *cells*, not of the distance check.
//
//   2. **A venue outside the radius never comes back.** The cells are wide, so
//      they contain plenty of venues that are not close enough. The exact
//      haversine distance is what removes them.
//
// The first is tested by sampling the rim of the disc — the hardest points to
// cover — and asserting that every one of them lands in one of the returned
// cells. The second is tested against a database stub that hands back a venue
// past the radius.
// ---------------------------------------------------------------------------

/** A point, in decimal degrees. */
const LIMA = { latitude: -12.05, longitude: -77.04 };
const SANTIAGO = { latitude: -33.4489, longitude: -70.6693 };

/** The mean earth radius, in metres. The same one the haversine uses. */
const EARTH_RADIUS_METERS = 6371008.8;

/** Metres per degree of latitude on a sphere of that radius. */
const METERS_PER_DEGREE = (Math.PI * EARTH_RADIUS_METERS) / 180;

/**
 * Deterministic points inside a disc, densest at the rim.
 *
 * The rim is the part that a coarse filter is most likely to lose, so the
 * sample is weighted towards it: a venue just inside the boundary is the one
 * that must not be missed.
 */
function sampleDisc(
  centre: { latitude: number; longitude: number },
  radiusMeters: number,
  count: number,
): { latitude: number; longitude: number }[] {
  const points: { latitude: number; longitude: number }[] = [centre];

  for (let index = 0; index < count; index += 1) {
    const bearing = (2 * Math.PI * index) / count;
    // The square root pushes the samples towards the rim.
    const distance = radiusMeters * Math.sqrt((index + 1) / count);
    const latitudeOffset = (distance * Math.cos(bearing)) / METERS_PER_DEGREE;
    const longitudeOffset =
      (distance * Math.sin(bearing)) /
      (METERS_PER_DEGREE * Math.cos((centre.latitude * Math.PI) / 180));

    points.push({
      latitude: centre.latitude + latitudeOffset,
      longitude: centre.longitude + longitudeOffset,
    });
  }

  return points;
}

/** A stand-in for the Drizzle instance the query reads through. */
function mockDb(rows: Record<string, unknown>[] = []) {
  const calls: { from?: unknown; where?: unknown } = {};

  const db = {
    select: () => ({
      from: (table: unknown) => {
        calls.from = table;
        return {
          where: (where: unknown) => {
            calls.where = where;
            return Promise.resolve(rows);
          },
        };
      },
    }),
  };

  return { db, calls };
}

/** The SQL the query's predicate renders to, and the values it binds. */
function renderedPredicate(where: unknown): { sql: string; params: unknown[] } {
  const { sql, params } = new PgDialect().sqlToQuery(where as SQL);
  return { sql, params };
}

describe('haversineDistanceMeters', () => {
  it('is zero for the same point', () => {
    expect(haversineDistanceMeters(LIMA, LIMA)).toBe(0);
  });

  it('measures a degree of latitude', () => {
    // One degree of latitude on a sphere of the mean radius. The value is
    // asserted with a tolerance because the constant is a definition, not a
    // measurement: the point of the assertion is that the function is in
    // metres and not in degrees.
    const distance = haversineDistanceMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });

    expect(distance).toBeGreaterThan(111_000);
    expect(distance).toBeLessThan(111_400);
  });

  it('measures a degree of longitude at the equator', () => {
    const distance = haversineDistanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 });

    expect(distance).toBeGreaterThan(111_000);
    expect(distance).toBeLessThan(111_400);
  });

  it('is symmetric', () => {
    expect(haversineDistanceMeters(LIMA, SANTIAGO)).toBeCloseTo(
      haversineDistanceMeters(SANTIAGO, LIMA),
      6,
    );
  });

  it('measures the real distance between two cities', () => {
    // Lima to Santiago is about 2,460 km.
    const distance = haversineDistanceMeters(LIMA, SANTIAGO);

    expect(distance).toBeGreaterThan(2_400_000);
    expect(distance).toBeLessThan(2_550_000);
  });
});

describe('geohashPrecisionForRadius', () => {
  it.each([
    // The table the module documents: the radius a radius buys, and the
    // precision whose cell and its eight neighbours cover it.
    { radiusMeters: 500, precision: 6 },
    { radiusMeters: 1_500, precision: 5 },
    { radiusMeters: 5_000, precision: 4 },
    { radiusMeters: 20_000, precision: 3 },
    { radiusMeters: 50_000, precision: 3 },
  ])('covers a radius of $radiusMeters metres at precision $precision', ({ radiusMeters, precision }) => {
    expect(geohashPrecisionForRadius(LIMA.latitude, LIMA.longitude, radiusMeters)).toBe(precision);
  });

  it('never asks for a prefix longer than the stored geohash', () => {
    // A branch stores its geohash at the default precision, so a longer prefix
    // could never match a stored row — the venue would be invisible.
    for (const radiusMeters of [1, 10, 50, 100, 500, 1_500, 5_000, 50_000]) {
      expect(geohashPrecisionForRadius(LIMA.latitude, LIMA.longitude, radiusMeters)).toBeLessThanOrEqual(6);
    }
  });
});

describe('geohashCellsForRadius', () => {
  it('returns the centre cell and its eight neighbours', () => {
    const cells = geohashCellsForRadius(LIMA.latitude, LIMA.longitude, 1_500);

    expect(cells).toHaveLength(9);
    // The centre cell is one of them: the venue the caller pointed at is
    // inside the disc by definition.
    expect(cells).toContain('6mc5q');
  });

  it('never misses a point inside the radius', () => {
    // The guarantee. Every point of the disc — the rim especially — has to land
    // in one of the returned cells, because a venue outside them never reaches
    // the exact distance filter.
    for (const radiusMeters of [500, 1_500, 5_000, 20_000, 50_000]) {
      const cells = new Set(geohashCellsForRadius(LIMA.latitude, LIMA.longitude, radiusMeters));
      const precision = geohashPrecisionForRadius(LIMA.latitude, LIMA.longitude, radiusMeters);

      for (const point of sampleDisc(LIMA, radiusMeters, 64)) {
        const hash = encode(point.latitude, point.longitude, precision);
        expect(cells.has(hash), `radius ${radiusMeters} missed ${point.latitude},${point.longitude}`).toBe(
          true,
        );
      }
    }
  });

  it('covers the disc around a point in a high latitude too', () => {
    // The longitude cell shrinks towards the poles, so the same radius needs a
    // coarser cell there. A coverage rule that ignored the latitude would lose
    // venues in Reykjavik.
    const reykjavik = { latitude: 64.1466, longitude: -21.9426 };
    const radiusMeters = 20_000;
    const cells = new Set(geohashCellsForRadius(reykjavik.latitude, reykjavik.longitude, radiusMeters));
    const precision = geohashPrecisionForRadius(
      reykjavik.latitude,
      reykjavik.longitude,
      radiusMeters,
    );

    for (const point of sampleDisc(reykjavik, radiusMeters, 64)) {
      expect(cells.has(encode(point.latitude, point.longitude, precision))).toBe(true);
    }
  });
});

describe('findBranchesInRadius', () => {
  it('returns the venues inside the radius, with their distance', async () => {
    const { db } = mockDb([
      {
        id: 'branch-near',
        name: 'Near',
        businessId: 'biz-1',
        latitude: '-12.0500',
        longitude: '-77.0400',
      },
      {
        id: 'branch-far',
        name: 'Far',
        businessId: 'biz-1',
        latitude: '-12.5000',
        longitude: '-77.0400',
      },
    ]);

    const found = await findBranchesInRadius(db, {
      businessId: 'biz-1',
      latitude: LIMA.latitude,
      longitude: LIMA.longitude,
      radiusMeters: 1_500,
    });

    // The far one is in a cell of the coarse filter and is removed by the
    // exact distance check, which is the second of the two stages.
    expect(found.map((branch) => branch.id)).toEqual(['branch-near']);
    expect(found[0].distanceMeters).toBeLessThan(1_500);
  });

  it('never returns a venue without coordinates', async () => {
    // "No position" is not "everywhere". A venue that has not registered a
    // position is not in the radius of anything.
    const { db } = mockDb([
      {
        id: 'branch-without-position',
        name: 'No position',
        businessId: 'biz-1',
        latitude: null,
        longitude: null,
      },
    ]);

    const found = await findBranchesInRadius(db, {
      businessId: 'biz-1',
      latitude: LIMA.latitude,
      longitude: LIMA.longitude,
      radiusMeters: 1_500,
    });

    expect(found).toEqual([]);
  });

  it('never returns a venue of another tenant', async () => {
    const { db } = mockDb([
      {
        id: 'branch-other-tenant',
        name: 'Theirs',
        businessId: 'biz-2',
        latitude: '-12.0500',
        longitude: '-77.0400',
      },
    ]);

    const found = await findBranchesInRadius(db, {
      businessId: 'biz-1',
      latitude: LIMA.latitude,
      longitude: LIMA.longitude,
      radiusMeters: 1_500,
    });

    expect(found).toEqual([]);
  });

  it('scopes the query to the tenant, to a position, and to the computed cells', async () => {
    const { db, calls } = mockDb([]);

    await findBranchesInRadius(db, {
      businessId: 'biz-1',
      latitude: LIMA.latitude,
      longitude: LIMA.longitude,
      radiusMeters: 1_500,
    });

    const { sql, params } = renderedPredicate(calls.where);

    // The tenant, so another business's venue is not even a candidate.
    expect(sql).toContain('business_id');
    expect(params).toContain('biz-1');
    // A venue without a position has no geohash and no distance.
    expect(sql).toContain('"latitude" is not null');
    expect(sql).toContain('"longitude" is not null');
    // The coarse filter: a prefix match on the geohash, one pattern per cell.
    expect(sql).toContain('geohash');
    const patterns = params.filter((param) => typeof param === 'string' && param.endsWith('%'));
    expect(patterns.length).toBe(9);
  });
});

/**
 * The geohash of a point, at the given precision.
 *
 * The module under test computes its own cells with the shared encoder, and a
 * test that used a different encoder would be testing the wrong thing — so
 * this calls the very same one.
 */
function encode(latitude: number, longitude: number, precision: number): string {
  return encodeGeohash(latitude, longitude, precision);
}
