// ---------------------------------------------------------------------------
// Venue position, as the route receives it and as the database stores it.
//
// This is the whole of the position logic, and it is pure: no database, no
// request, no clock. That is deliberate. The rules that decide what a valid
// position is — a pair or nothing, on the globe, encoded at a fixed precision —
// are the rules the database enforces again in constraints, and the only way
// for two sets of rules to agree is for them to be written once and checked
// against each other.
//
// The database constraints are the authority (a second writer and a script
// cannot be asked to call this function), and this module is what turns a
// caller's mistake into a message instead of a 500 from a check violation.
// ---------------------------------------------------------------------------

import { DEFAULT_GEOHASH_PRECISION, decodeGeohash, encodeGeohash } from '@vyloop/db';

/**
 * Why a position was refused, as codes the route can branch on.
 *
 * Shared with the caller because the dashboard distinguishes "you gave me half
 * a position" from "that is not a place on Earth", and both are the caller's
 * mistake to fix — but they are different mistakes.
 */
export const BRANCH_LOCATION_ERROR = {
  /** One coordinate arrived without the other. */
  INCOMPLETE: 'BRANCH_LOCATION_INCOMPLETE',
  /** A coordinate arrived that is not a number. */
  INVALID: 'BRANCH_LOCATION_INVALID',
  /** A coordinate arrived that is outside the globe. */
  OUT_OF_RANGE: 'BRANCH_LOCATION_OUT_OF_RANGE',
  /** A geohash arrived that is not a geohash. */
  INVALID_GEOHASH: 'BRANCH_LOCATION_INVALID_GEOHASH',
} as const;

export type BranchLocationErrorCode =
  (typeof BRANCH_LOCATION_ERROR)[keyof typeof BRANCH_LOCATION_ERROR];

/** A position, resolved and ready to write. */
export interface BranchLocation {
  latitude: number;
  longitude: number;
  geohash: string;
  geohashPrecision: number;
}

export type BranchLocationOutcome =
  | { ok: true; location: BranchLocation }
  | { ok: false; code: BranchLocationErrorCode; message: string };

/**
 * The shape a caller may send.
 *
 * `latitude`, `longitude` and `geohash` are all `unknown` because this is what
 * arrives from JSON: the route's job is to find out what it is, not to trust
 * that it is what the type says.
 */
export interface BranchLocationInput {
  latitude?: unknown;
  longitude?: unknown;
  geohash?: unknown;
}

/** A coordinate that was not sent at all, as distinct from one sent as null. */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * Read a coordinate that may have arrived as a number or as a numeric string.
 *
 * A JSON body can carry either, and a dashboard form sends a string. Refusing
 * the string would mean the caller has to know which one this API wants.
 * `Number('') ` is 0, so an empty string is refused explicitly — an empty
 * input silently becoming a position off the coast of Africa is not a
 * rounding detail.
 */
function toCoordinate(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Resolve the position a caller asked for.
 *
 * Three shapes are accepted, and exactly one of them is "no position":
 *
 *   - **`latitude` and `longitude` together.** The position is those
 *     coordinates, and the geohash is computed from them here so the column
 *     and the coordinates can never disagree.
 *   - **a `geohash` alone.** The position is the centre of the cell the
 *     geohash names. That is cell-accurate and nothing finer, which is what a
 *     geohash carries; the caller sent a cell, so the cell's centre is what
 *     is recorded.
 *   - **none of them.** The caller is not asking for a position. That is not
 *     an error here — it is how a route clears one — so it is reported
 *     separately from a refusal.
 *
 * A caller that sends one coordinate and not the other has made a mistake
 * rather than a choice, and is told so: half a position is not a position, and
 * the database's own constraint would reject the write anyway.
 */
export function resolveBranchLocation(
  input: BranchLocationInput,
): BranchLocationOutcome | { ok: false; code: 'BRANCH_LOCATION_ABSENT'; message: string } {
  const hasLatitude = !isAbsent(input.latitude);
  const hasLongitude = !isAbsent(input.longitude);

  // A geohash that was sent and is not a string is a mistake, and it has to be
  // reported as one. Treating it as "no geohash" would make a request that
  // asked for a position succeed with the position empty — the caller would
  // be told 201 and the venue would silently appear in no nearby query.
  if (!isAbsent(input.geohash) && typeof input.geohash !== 'string') {
    return {
      ok: false,
      code: BRANCH_LOCATION_ERROR.INVALID_GEOHASH,
      message: 'geohash must be a string.',
    };
  }

  const hasGeohash = typeof input.geohash === 'string' && input.geohash.trim() !== '';

  if (!hasLatitude && !hasLongitude && !hasGeohash) {
    return {
      ok: false,
      code: 'BRANCH_LOCATION_ABSENT',
      message: 'No position was supplied.',
    };
  }

  // A pair of coordinates wins over a geohash when both arrive. The geohash is
  // the derived value, so trusting it over the coordinates would mean storing a
  // cell centre next to a precise point and having the two disagree.
  if (hasLatitude || hasLongitude) {
    if (!hasLatitude || !hasLongitude) {
      return {
        ok: false,
        code: BRANCH_LOCATION_ERROR.INCOMPLETE,
        message:
          'A position needs both latitude and longitude. Send both, or send neither to clear it.',
      };
    }

    const latitude = toCoordinate(input.latitude);
    const longitude = toCoordinate(input.longitude);

    if (latitude === null || longitude === null) {
      return {
        ok: false,
        code: BRANCH_LOCATION_ERROR.INVALID,
        message: 'latitude and longitude must be numbers.',
      };
    }

    if (latitude < -90 || latitude > 90) {
      return {
        ok: false,
        code: BRANCH_LOCATION_ERROR.OUT_OF_RANGE,
        message: 'latitude must be between -90 and 90.',
      };
    }

    if (longitude < -180 || longitude > 180) {
      return {
        ok: false,
        code: BRANCH_LOCATION_ERROR.OUT_OF_RANGE,
        message: 'longitude must be between -180 and 180.',
      };
    }

    return {
      ok: true,
      location: {
        latitude,
        longitude,
        geohash: encodeGeohash(latitude, longitude, DEFAULT_GEOHASH_PRECISION),
        geohashPrecision: DEFAULT_GEOHASH_PRECISION,
      },
    };
  }

  // A geohash alone. Decoded here so that what is stored is a pair of
  // coordinates and a geohash that the server computed from them, rather than
  // a geohash string the server believed.
  try {
    const decoded = decodeGeohash(input.geohash as string);
    return {
      ok: true,
      location: {
        latitude: decoded.latitude,
        longitude: decoded.longitude,
        geohash: encodeGeohash(decoded.latitude, decoded.longitude, decoded.precision),
        geohashPrecision: decoded.precision,
      },
    };
  } catch {
    return {
      ok: false,
      code: BRANCH_LOCATION_ERROR.INVALID_GEOHASH,
      message: 'geohash must be a geohash: characters 0-9 and b-z, without a, i, l or o.',
    };
  }
}
