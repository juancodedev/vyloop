import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GEOHASH_PRECISION,
  MAX_GEOHASH_PRECISION,
  MIN_GEOHASH_PRECISION,
  decodeGeohash,
  encodeGeohash,
} from './geohash';

// ---------------------------------------------------------------------------
// The vectors below are the published geohashes of places whose geohash is
// recorded in the geohash literature, plus null island. They are here to catch
// the two ways this function can be wrong while still looking right:
//
//   1. **A different boundary convention.** `>=` and `>` disagree only for a
//      point exactly on a cell boundary, which is null island among the places
//      anyone actually names. A `>` implementation produces `7zzzzzzzzzzz` for
//      the origin instead of `s00000000000`, and every other vector here still
//      passes — so the origin vector is the one that catches it.
//
//   2. **A transposed bit order.** Longitude on the even bits and latitude on
//      the odd ones, or the other way round. A transposition produces a
//      well-formed geohash of the right length that sorts by nothing useful,
//      and every assertion about the shape still passes. Only the published
//      values catch it.
//
// Neither is a detail of this implementation: a geohash written by this
// function is compared against a geohash computed by whatever map provider the
// business uses, and the two have to name the same cell.
// ---------------------------------------------------------------------------

describe('encodeGeohash', () => {
  describe('published values', () => {
    it('encodes the canonical example', () => {
      // The example the geohash specification is written around.
      expect(encodeGeohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj');
    });

    it('encodes null island as the published value', () => {
      // The origin sits exactly on the equator and on the prime meridian, so it
      // is the one named point that is also exactly on a cell boundary.
      expect(encodeGeohash(0, 0, 12)).toBe('s00000000000');
    });

    it.each([
      ['New York', 40.7128, -74.006, 6, 'dr5reg'],
      ['San Francisco', 37.7749, -122.4194, 5, '9q8yy'],
      ['London', 51.5074, -0.1278, 5, 'gcpvj'],
      ['Sydney', -33.8688, 151.2093, 5, 'r3gx2'],
      ['Santiago', -33.4489, -70.6693, 6, '66j9xy'],
    ])('encodes %s', (_name, latitude, longitude, precision, expected) => {
      expect(encodeGeohash(latitude, longitude, precision)).toBe(expected);
    });
  });

  describe('shape', () => {
    it('produces exactly the requested number of characters', () => {
      for (
        let precision = MIN_GEOHASH_PRECISION;
        precision <= MAX_GEOHASH_PRECISION;
        precision += 1
      ) {
        expect(encodeGeohash(-33.4489, -70.6693, precision)).toHaveLength(precision);
      }
    });

    it('uses only the base-32 alphabet without the confusable characters', () => {
      const hash = encodeGeohash(51.5074, -0.1278, 12);
      expect(hash).toMatch(/^[0-9bcdefghjkmnpqrstuvwxyz]+$/);
      // `a`, `i`, `l` and `o` are excluded on purpose: they are the characters
      // a person misreads when copying a geohash off a screen.
      expect(hash).not.toMatch(/[ailo]/);
    });

    it('defaults to the coarse precision', () => {
      expect(DEFAULT_GEOHASH_PRECISION).toBe(6);
      expect(encodeGeohash(-33.4489, -70.6693)).toBe(
        encodeGeohash(-33.4489, -70.6693, DEFAULT_GEOHASH_PRECISION),
      );
    });
  });

  describe('the property the index depends on', () => {
    it('gives two nearby points a shared prefix', () => {
      // This is why the column is indexed: the nearby-venues lookup is a
      // prefix match, and it only works if points that are close together
      // share a prefix.
      const nearby = encodeGeohash(-33.4489, -70.6693, 6);
      const aBlockAway = encodeGeohash(-33.4489, -70.6693 + 0.0005, 6);

      expect(nearby.slice(0, 4)).toBe(aBlockAway.slice(0, 4));
    });

    it('gives a distant point a different prefix', () => {
      const santiago = encodeGeohash(-33.4489, -70.6693, 6);
      const newYork = encodeGeohash(40.7128, -74.006, 6);

      expect(santiago.slice(0, 4)).not.toBe(newYork.slice(0, 4));
    });

    it('refines as the precision rises', () => {
      // A longer geohash is a smaller cell, so it cannot disagree with its
      // own shorter prefix.
      const coarse = encodeGeohash(-33.4489, -70.6693, 5);
      const fine = encodeGeohash(-33.4489, -70.6693, 9);

      expect(fine.startsWith(coarse)).toBe(true);
    });
  });

  describe('out-of-range input', () => {
    it('refuses a latitude outside the globe', () => {
      expect(() => encodeGeohash(91, 0)).toThrow(RangeError);
      expect(() => encodeGeohash(-90.0001, 0)).toThrow(RangeError);
    });

    it('refuses a longitude outside the globe', () => {
      expect(() => encodeGeohash(0, 181)).toThrow(RangeError);
      expect(() => encodeGeohash(0, -180.0001)).toThrow(RangeError);
    });

    it('refuses a non-finite coordinate', () => {
      expect(() => encodeGeohash(Number.NaN, 0)).toThrow(RangeError);
      expect(() => encodeGeohash(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    });

    it('accepts the extremes of the globe', () => {
      expect(() => encodeGeohash(90, 180)).not.toThrow();
      expect(() => encodeGeohash(-90, -180)).not.toThrow();
    });

    it('refuses a precision that is not a usable number of characters', () => {
      expect(() => encodeGeohash(0, 0, 0)).toThrow(RangeError);
      expect(() => encodeGeohash(0, 0, 13)).toThrow(RangeError);
      expect(() => encodeGeohash(0, 0, 6.5)).toThrow(RangeError);
    });
  });
});

describe('decodeGeohash', () => {
  it('reads back the centre of the cell', () => {
    // Precision 6 keeps roughly a kilometre, so the centre of the cell a point
    // fell into is close to that point but not equal to it. The bound is the
    // cell size, which is the honest claim: a decoded geohash is cell-accurate
    // and nothing finer.
    const decoded = decodeGeohash('66j9xy');
    expect(Math.abs(decoded.latitude - -33.4489)).toBeLessThan(0.02);
    expect(Math.abs(decoded.longitude - -70.6693)).toBeLessThan(0.02);
    expect(decoded.precision).toBe(6);
  });

  it('round-trips a point into a cell that contains it', () => {
    // The property the server relies on: a geohash it wrote is a geohash it can
    // read back, and the cell it names is the cell the point is in.
    const latitude = -33.4489;
    const longitude = -70.6693;

    const decoded = decodeGeohash(encodeGeohash(latitude, longitude, 9));

    expect(encodeGeohash(decoded.latitude, decoded.longitude, 9)).toBe(
      encodeGeohash(latitude, longitude, 9),
    );
  });

  it('reads back the published values', () => {
    // The canonical example, decoded: the point is inside the cell its own
    // geohash names.
    const decoded = decodeGeohash('u4pruydqqvj');
    expect(decoded.latitude).toBeGreaterThan(57.6);
    expect(decoded.latitude).toBeLessThan(57.7);
    expect(decoded.longitude).toBeGreaterThan(10.4);
    expect(decoded.longitude).toBeLessThan(10.5);
    expect(decoded.precision).toBe(11);
  });

  it('normalises case and surrounding space', () => {
    expect(decodeGeohash('  66J9XY ')).toEqual(decodeGeohash('66j9xy'));
  });

  it('refuses a character outside the alphabet', () => {
    // `a`, `i`, `l` and `o` are the four characters the alphabet omits, so
    // they are the ones a decoder has to reject.
    expect(() => decodeGeohash('66j9xa')).toThrow(RangeError);
    expect(() => decodeGeohash('66j9xi')).toThrow(RangeError);
    expect(() => decodeGeohash('66j9xl')).toThrow(RangeError);
    expect(() => decodeGeohash('66j9xo')).toThrow(RangeError);
    expect(() => decodeGeohash('')).toThrow(RangeError);
  });
});
