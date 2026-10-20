import { describe, expect, it } from 'vitest';

import { BRANCH_LOCATION_ERROR, resolveBranchLocation } from './branch-location';

// ---------------------------------------------------------------------------
// The rules a position has to satisfy, and the messages a caller gets when it
// does not.
//
// This module is the whole of the position logic and it is pure, so these
// tests are the whole of its coverage. The database enforces the same rules
// again in constraints — a second writer and a script cannot be asked to call
// this function — and the point of testing both is that they agree.
// ---------------------------------------------------------------------------

describe('resolveBranchLocation', () => {
  describe('a pair of coordinates', () => {
    it('accepts them and computes the geohash', () => {
      const outcome = resolveBranchLocation({ latitude: -33.4489, longitude: -70.6693 });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      expect(outcome.location.latitude).toBe(-33.4489);
      expect(outcome.location.longitude).toBe(-70.6693);
      // The geohash is computed here, not taken from the caller, so the column
      // and the coordinates cannot disagree.
      expect(outcome.location.geohash).toBe('66j9xy');
      expect(outcome.location.geohashPrecision).toBe(6);
    });

    it('accepts coordinates sent as strings', () => {
      // A dashboard form sends a string. Refusing it would mean the caller has
      // to know which of the two this API wants.
      const outcome = resolveBranchLocation({ latitude: '-33.4489', longitude: '-70.6693' });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.location.latitude).toBe(-33.4489);
      expect(outcome.location.longitude).toBe(-70.6693);
    });

    it('accepts the extremes of the globe', () => {
      expect(resolveBranchLocation({ latitude: 90, longitude: 180 }).ok).toBe(true);
      expect(resolveBranchLocation({ latitude: -90, longitude: -180 }).ok).toBe(true);
    });
  });

  describe('half a position', () => {
    it('refuses a latitude without a longitude', () => {
      const outcome = resolveBranchLocation({ latitude: -33.4489 });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe(BRANCH_LOCATION_ERROR.INCOMPLETE);
    });

    it('refuses a longitude without a latitude', () => {
      const outcome = resolveBranchLocation({ longitude: -70.6693 });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe(BRANCH_LOCATION_ERROR.INCOMPLETE);
    });
  });

  describe('a coordinate that is not a coordinate', () => {
    it('refuses a value that is not a number', () => {
      const outcome = resolveBranchLocation({ latitude: 'north', longitude: '-70.6693' });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe(BRANCH_LOCATION_ERROR.INVALID);
    });

    it('refuses an empty string rather than reading it as zero', () => {
      // `Number('')` is 0, so an empty input would silently become a position
      // off the coast of Africa.
      const outcome = resolveBranchLocation({ latitude: '', longitude: '-70.6693' });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe(BRANCH_LOCATION_ERROR.INVALID);
    });

    it('refuses a value that is not finite', () => {
      const outcome = resolveBranchLocation({ latitude: Number.NaN, longitude: 0 });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe(BRANCH_LOCATION_ERROR.INVALID);
    });
  });

  describe('a coordinate outside the globe', () => {
    it('refuses a latitude above the pole', () => {
      const outcome = resolveBranchLocation({ latitude: 91, longitude: 0 });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe(BRANCH_LOCATION_ERROR.OUT_OF_RANGE);
      expect(outcome.message).toContain('latitude');
    });

    it('refuses a longitude past the date line', () => {
      const outcome = resolveBranchLocation({ latitude: 0, longitude: 181 });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe(BRANCH_LOCATION_ERROR.OUT_OF_RANGE);
      expect(outcome.message).toContain('longitude');
    });
  });

  describe('a geohash on its own', () => {
    it('accepts it and records the centre of the cell it names', () => {
      const outcome = resolveBranchLocation({ geohash: '66j9xy' });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      // Cell-accurate, and no more than that: a geohash carries a cell, not a
      // point, so the centre of the cell is what it can honestly mean.
      expect(Math.abs(outcome.location.latitude - -33.4489)).toBeLessThan(0.02);
      expect(Math.abs(outcome.location.longitude - -70.6693)).toBeLessThan(0.02);
      expect(outcome.location.geohash).toBe('66j9xy');
      expect(outcome.location.geohashPrecision).toBe(6);
    });

    it('prefers the coordinates when both arrive', () => {
      // The geohash is the derived value, so trusting it over the coordinates
      // would store a cell centre next to a precise point and have the two
      // disagree.
      const outcome = resolveBranchLocation({
        latitude: -33.4489,
        longitude: -70.6693,
        geohash: 'u4pruydqqvj',
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.location.geohash).toBe('66j9xy');
    });

    it('refuses a string that is not a geohash', () => {
      const outcome = resolveBranchLocation({ geohash: 'not a geohash' });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe(BRANCH_LOCATION_ERROR.INVALID_GEOHASH);
    });
  });

  describe('no position at all', () => {
    it('reports it separately from a refusal', () => {
      // Clearing a position is a request, not a mistake, and it has to be
      // distinguishable from one.
      const outcome = resolveBranchLocation({});

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('BRANCH_LOCATION_ABSENT');
    });

    it('reports it when every field is null', () => {
      const outcome = resolveBranchLocation({ latitude: null, longitude: null, geohash: null });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('BRANCH_LOCATION_ABSENT');
    });
  });
});
