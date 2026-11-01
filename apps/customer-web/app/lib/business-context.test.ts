import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recallBusinessSlug, rememberBusinessSlug, resolveBusinessSlug } from './business-context';

describe('the business context', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('takes the business from the link when it has one, and remembers it', () => {
    expect(resolveBusinessSlug('cafe-central')).toBe('cafe-central');
    expect(recallBusinessSlug()).toBe('cafe-central');
  });

  it('falls back to the last business when the link lost it', () => {
    // A session that expires on /profile redirects to a bare /login; without
    // this the customer is told to scan the QR again.
    rememberBusinessSlug('cafe-central');

    expect(resolveBusinessSlug(null)).toBe('cafe-central');
  });

  it('lets a new link replace the remembered business', () => {
    rememberBusinessSlug('cafe-central');

    expect(resolveBusinessSlug('barber')).toBe('barber');
    expect(resolveBusinessSlug(null)).toBe('barber');
  });

  it('has no business when neither the link nor the browser has one', () => {
    expect(resolveBusinessSlug(null)).toBeNull();
    expect(resolveBusinessSlug('')).toBeNull();
  });

  it('still works from the link when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(resolveBusinessSlug('cafe-central')).toBe('cafe-central');
    expect(resolveBusinessSlug(null)).toBeNull();
  });
});
