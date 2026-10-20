// ---------------------------------------------------------------------------
// Geohash encoding
// ---------------------------------------------------------------------------
// A geohash is a base-32 encoding of a coordinate pair into a string that sorts
// by proximity: two points that are close together share a prefix.
//
// It exists here, in `@vyloop/db`, for the same reason `slug.ts` does — it is a
// pure helper that two workers need to agree about, and the value it produces
// is stored in a column this package owns. `workers/identity` computes it when
// a venue's position is written; the notification worker will compare prefixes
// when it looks for venues near a point. If the two computed it differently,
// the second would search for cells that the first never wrote.
//
// The algorithm is the standard one, and the comment on `BASE32` says why this
// alphabet and not the full 32 characters.
//
// No dependency: the algorithm is thirty lines, it has been stable for a
// decade, and a package that encoded coordinates would be a dependency to
// audit for a function nobody needs to be told about.
// ---------------------------------------------------------------------------

/**
 * The geohash alphabet.
 *
 * Base 32 without `a`, `i`, `l` and `o`: the characters most easily confused
 * with each other when a geohash is read aloud or copied off a screen. The
 * omission is what keeps a cell that a person transcribes from being a
 * different cell than the one the server computed.
 */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * The precision a venue is stored at.
 *
 * Six characters is roughly a 1.2 km × 0.6 km cell — wide enough that "branches
 * near this point" finds the branch, narrow enough that a geohash stored
 * against a venue is not a precise record of where that venue is.
 *
 * Seven (roughly 150 m) exists for a venue that legitimately serves a radius
 * that small, such as a kiosk inside a shopping centre, and a business has to
 * ask for it. The default is the coarse one because the coarse one is right
 * almost always.
 */
export const DEFAULT_GEOHASH_PRECISION = 6;

/** The coarsest precision that still names a cell. */
export const MIN_GEOHASH_PRECISION = 1;

/** The finest precision this encoder produces. */
export const MAX_GEOHASH_PRECISION = 12;

/**
 * Encode a coordinate pair as a geohash.
 *
 * @param latitude  Degrees north, in [-90, 90].
 * @param longitude Degrees east, in [-180, 180].
 * @param precision Characters in the result; each one halves the cell.
 *
 * @returns The geohash, `precision` characters long.
 *
 * @throws RangeError if a coordinate or the precision is out of range. The
 * caller validates the coordinates before it gets here — the route refuses a
 * latitude of 91 — and this is the second line of defence, not the first: a
 * geohash computed from an out-of-range coordinate would be a valid string
 * naming a cell nowhere near the planet.
 */
export function encodeGeohash(
  latitude: number,
  longitude: number,
  precision: number = DEFAULT_GEOHASH_PRECISION,
): string {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError(`latitude out of range: ${latitude}`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError(`longitude out of range: ${longitude}`);
  }
  if (
    !Number.isInteger(precision) ||
    precision < MIN_GEOHASH_PRECISION ||
    precision > MAX_GEOHASH_PRECISION
  ) {
    throw new RangeError(`precision out of range: ${precision}`);
  }

  // The cell is a rectangle, narrowed one bit at a time. Longitude is decided
  // on the even bits and latitude on the odd ones, which is what makes the
  // result sort by proximity: two nearby points take the same decisions for
  // longer, and so share a longer prefix.
  //
  // The comparison is `>=`, and that is the published convention rather than an
  // arbitrary choice. It decides which half of the world a point exactly on a
  // cell boundary belongs to, and the published value for null island — the
  // origin, which sits exactly on the equator and on the prime meridian — is
  // `s00000000000`. An encoder using `>` instead produces `7zzzzzzzzzzz` for
  // that point, which is a different cell, and any geohash computed by a map
  // provider for the same place would not share a prefix with ours. The
  // difference is invisible for almost every point and fatal for exactly the
  // ones a business is most likely to look up by hand.
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;

  let hash = '';
  let bits = 0;
  let value = 0;
  let even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (longitude >= mid) {
        value = (value << 1) | 1;
        lngMin = mid;
      } else {
        value = value << 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (latitude >= mid) {
        value = (value << 1) | 1;
        latMin = mid;
      } else {
        value = value << 1;
        latMax = mid;
      }
    }
    even = !even;

    bits += 1;
    if (bits === 5) {
      hash += BASE32[value];
      bits = 0;
      value = 0;
    }
  }

  return hash;
}

/**
 * A geohash read back as a position.
 *
 * The position is the **centre of the cell**, not the point that produced the
 * geohash. A geohash is a lossy encoding: precision 6 keeps about a
 * kilometre, so the centre can be several hundred metres from the original
 * point. That is not a defect of this decoder — it is what a geohash is — and
 * it is why a position that arrives as a geohash is recorded as the cell
 * centre rather than as a claim of greater accuracy than the input carried.
 */
export interface DecodedGeohash {
  latitude: number;
  longitude: number;
  /** How many characters the geohash had, and therefore how wide its cell is. */
  precision: number;
}

/**
 * Decode a geohash back to the centre of its cell.
 *
 * The inverse of `encodeGeohash`, and the reason a client may send a geohash
 * instead of a pair of coordinates: the server normalises the input to
 * decimal degrees and recomputes the geohash from them, so the column is
 * written by the same code path whichever form the caller used.
 *
 * @throws RangeError if the string contains a character outside the alphabet.
 */
export function decodeGeohash(geohash: string): DecodedGeohash {
  const normalized = geohash.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new RangeError('geohash is empty');
  }

  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;

  let even = true;

  for (const character of normalized) {
    const value = BASE32.indexOf(character);
    if (value === -1) {
      throw new RangeError(`invalid geohash character: ${character}`);
    }

    // Most significant bit first, which is the order `encodeGeohash` writes
    // them in: it shifts the value left for every bit, so the first bit of a
    // character is the one that decides the largest part of the cell.
    for (let mask = 16; mask > 0; mask >>= 1) {
      if (even) {
        const mid = (lngMin + lngMax) / 2;
        if (value & mask) {
          lngMin = mid;
        } else {
          lngMax = mid;
        }
      } else {
        const mid = (latMin + latMax) / 2;
        if (value & mask) {
          latMin = mid;
        } else {
          latMax = mid;
        }
      }
      even = !even;
    }
  }

  return {
    latitude: (latMin + latMax) / 2,
    longitude: (lngMin + lngMax) / 2,
    precision: normalized.length,
  };
}
