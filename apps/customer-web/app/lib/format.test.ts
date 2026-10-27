// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { formatClp, formatMemberCode, formatMovementDate, initials } from './format';

describe('formatMovementDate', () => {
  const now = new Date('2026-10-26T12:00:00');

  it('returns Hoy for today', () => {
    expect(formatMovementDate('2026-10-26T08:00:00', now)).toBe('Hoy');
  });

  it('returns Ayer for yesterday', () => {
    expect(formatMovementDate('2026-10-25T08:00:00', now)).toBe('Ayer');
  });

  it('returns relative days up to six', () => {
    expect(formatMovementDate('2026-10-23T08:00:00', now)).toBe('Hace 3 días');
    expect(formatMovementDate('2026-10-20T08:00:00', now)).toBe('Hace 6 días');
  });

  it('switches to a short date after six days', () => {
    expect(formatMovementDate('2026-10-19T08:00:00', now)).toBe('19 oct');
  });

  it('appends the year when it is not the current one', () => {
    expect(formatMovementDate('2025-12-25T08:00:00', now)).toBe('25 dic 2025');
  });

  it('returns an empty string for empty or invalid input', () => {
    expect(formatMovementDate(null, now)).toBe('');
    expect(formatMovementDate('', now)).toBe('');
    expect(formatMovementDate('not-a-date', now)).toBe('');
  });
});

describe('formatClp', () => {
  it('formats an integer amount', () => {
    expect(formatClp(12345)).toBe('$12.345');
  });

  it('accepts a numeric string', () => {
    expect(formatClp('9876')).toBe('$9.876');
  });

  it('returns an empty string for null/empty/invalid', () => {
    expect(formatClp(null)).toBe('');
    expect(formatClp('')).toBe('');
    expect(formatClp('abc')).toBe('');
  });
});

describe('initials', () => {
  it('takes the first letter of the first two words', () => {
    expect(initials('Juan Muñoz')).toBe('JM');
  });

  it('handles a single word', () => {
    expect(initials('Juan')).toBe('J');
  });

  it('returns an empty string for empty input', () => {
    expect(initials(null)).toBe('');
    expect(initials('')).toBe('');
  });
});

describe('formatMemberCode', () => {
  it('groups the code in threes for dictation', () => {
    expect(formatMemberCode('K7F2QX')).toBe('K7F 2QX');
  });

  it('leaves a trailing short group as it is', () => {
    expect(formatMemberCode('K7F2Q')).toBe('K7F 2Q');
  });

  it('returns an empty string for an absent code', () => {
    expect(formatMemberCode(undefined)).toBe('');
    expect(formatMemberCode('')).toBe('');
  });
});
