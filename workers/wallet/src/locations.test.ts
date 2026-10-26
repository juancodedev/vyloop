import { describe, expect, it } from 'vitest';

import { MERCHANT_LOCATION_LIMIT, selectMerchantLocations } from './locations';

function venue(latitude: number, longitude: number, day = 1) {
  return { latitude, longitude, locatedAt: new Date(`2026-09-${String(day).padStart(2, '0')}`) };
}

describe('selectMerchantLocations', () => {
  it('keeps every position when the business has a few venues', () => {
    expect(selectMerchantLocations([venue(1, 2, 1), venue(3, 4, 2), venue(5, 6, 3)])).toEqual([
      { latitude: 5, longitude: 6 },
      { latitude: 3, longitude: 4 },
      { latitude: 1, longitude: 2 },
    ]);
  });

  it('carries at most ten positions, keeping the most recently asserted', () => {
    const twelve = Array.from({ length: 12 }, (_, index) => venue(index, index, index + 1));

    const selected = selectMerchantLocations(twelve);

    expect(MERCHANT_LOCATION_LIMIT).toBe(10);
    expect(selected).toHaveLength(10);
    // The two oldest positions are the ones Google never sees.
    expect(selected[0]).toEqual({ latitude: 11, longitude: 11 });
    expect(selected[9]).toEqual({ latitude: 2, longitude: 2 });
  });

  it('drops a position that is not a finite coordinate', () => {
    expect(selectMerchantLocations([venue(Number.NaN, 2), venue(3, 4)])).toEqual([
      { latitude: 3, longitude: 4 },
    ]);
  });

  it('sorts a venue with no located_at stamp last rather than dropping it', () => {
    const selected = selectMerchantLocations([
      { latitude: 1, longitude: 1, locatedAt: null },
      venue(2, 2),
    ]);

    expect(selected).toEqual([
      { latitude: 2, longitude: 2 },
      { latitude: 1, longitude: 1 },
    ]);
  });
});
