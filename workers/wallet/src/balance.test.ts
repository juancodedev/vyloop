import { describe, expect, it } from 'vitest';

import {
  BALANCE_DISPLAY_MAX,
  BALANCE_DISPLAY_MAX_LENGTH,
  BalanceNotDisplayableError,
  balanceDisplayFailure,
  formatBalance,
} from './balance';

describe('formatBalance', () => {
  it('renders zero', () => {
    expect(formatBalance(0)).toBe('0');
  });

  it('renders a small balance as plain digits', () => {
    expect(formatBalance(1)).toBe('1');
    expect(formatBalance(42)).toBe('42');
    expect(formatBalance(96942)).toBe('96942');
  });

  it('never inserts a thousands separator', () => {
    // `96.942` is 6 characters for 5 digits, and 7 is the whole budget. A
    // separator spends the budget on decoration and drops the usable ceiling by
    // an order of magnitude.
    expect(formatBalance(96942)).toBe('96942');
    expect(formatBalance(1000)).toBe('1000');
    expect(formatBalance(999999)).toBe('999999');
    expect(formatBalance(1234567)).toBe('1234567');
  });

  it('is never locale-dependent', () => {
    // A locale-aware path is one comma away from producing "96,942", and the
    // Workers ICU build is not guaranteed to be present at all.
    for (const points of [1, 999, 1000, 10000, 100000, 1000000]) {
      expect(formatBalance(points)).toBe(String(points));
      expect(formatBalance(points)).not.toMatch(/[.,\s]/);
    }
  });

  it('fits the documented character budget at the ceiling', () => {
    const formatted = formatBalance(BALANCE_DISPLAY_MAX);
    expect(formatted).toBe('9999999');
    expect(formatted).toHaveLength(BALANCE_DISPLAY_MAX_LENGTH);
    expect(BALANCE_DISPLAY_MAX).toBe(9_999_999);
  });

  it('produces at most BALANCE_DISPLAY_MAX_LENGTH characters anywhere in range', () => {
    for (const points of [0, 1, 9, 10, 99, 100, 999, 1000, 9999, 10000, 99999, 100000, 999999,
      1000000, 9999999]) {
      expect(formatBalance(points).length).toBeLessThanOrEqual(BALANCE_DISPLAY_MAX_LENGTH);
    }
  });

  it('rejects a balance past the documented ceiling instead of truncating', () => {
    // Truncating to the top 7 digits would show 9999999 to a member holding
    // 12345678. A wrong balance at a till is a support incident and a trust
    // problem; a loud error is an explicit product decision instead.
    expect(() => formatBalance(BALANCE_DISPLAY_MAX + 1)).toThrow(BalanceNotDisplayableError);
    expect(() => formatBalance(10_000_000)).toThrow(BalanceNotDisplayableError);
    expect(() => formatBalance(123_456_789)).toThrow(BalanceNotDisplayableError);
  });

  it('names the strategy change in the over-ceiling error', () => {
    // Whoever hits this needs to know what to do, not just that it failed.
    expect(() => formatBalance(10_000_000)).toThrow(/secondaryLoyaltyPoints/);
    expect(() => formatBalance(10_000_000)).toThrow(/9999999/);
  });

  it('rejects a negative balance', () => {
    // `-1000` is 5 characters and would render, but a negative loyalty balance
    // is not a state this system asserts; it means the ledger is wrong.
    expect(() => formatBalance(-1)).toThrow(BalanceNotDisplayableError);
    expect(() => formatBalance(-1000)).toThrow(BalanceNotDisplayableError);
  });

  it('rejects a fractional balance', () => {
    expect(() => formatBalance(1.5)).toThrow(BalanceNotDisplayableError);
    expect(() => formatBalance(0.1)).toThrow(BalanceNotDisplayableError);
  });

  it('rejects a non-finite value', () => {
    expect(() => formatBalance(Number.NaN)).toThrow(BalanceNotDisplayableError);
    expect(() => formatBalance(Number.POSITIVE_INFINITY)).toThrow(BalanceNotDisplayableError);
    expect(() => formatBalance(Number.NEGATIVE_INFINITY)).toThrow(BalanceNotDisplayableError);
  });

  it('carries the offending value on the error, so a log line is diagnosable', () => {
    try {
      formatBalance(12_345_678);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BalanceNotDisplayableError);
      expect((error as BalanceNotDisplayableError).points).toBe(12_345_678);
    }
  });

  it('does not compute a balance: it only formats the one it is given', () => {
    // The backend owns the balance. A formatter that derived one from a tier
    // table would be a second ledger.
    expect(formatBalance(96942)).toBe('96942');
    expect(formatBalance(96942)).not.toBe('96,942');
  });
});

describe('balanceDisplayFailure', () => {
  it('is null for a balance the pass can render', () => {
    for (const points of [0, 1, 42, 96942, 999999, 1234567, BALANCE_DISPLAY_MAX]) {
      expect(balanceDisplayFailure(points)).toBeNull();
    }
  });

  it('names the reason for a balance it cannot render', () => {
    // The predicate the status route reads, so a client is told the same
    // thing the builder would have refused with.
    expect(balanceDisplayFailure(BALANCE_DISPLAY_MAX + 1)).toMatch(/character budget/);
    expect(balanceDisplayFailure(Number.NaN)).toMatch(/not a finite number/);
    expect(balanceDisplayFailure(Number.POSITIVE_INFINITY)).toMatch(/not a finite number/);
    expect(balanceDisplayFailure(1.5)).toMatch(/fractional/);
    expect(balanceDisplayFailure(-1)).toMatch(/negative balance/);
  });

  it('agrees with formatBalance on every boundary, because it is the same rule', () => {
    // Two answers to one question is how a status endpoint promises a button
    // that the builder then refuses. The only safe arrangement is for the
    // predicate and the throw to be one function.
    for (const points of [-1, 0, 1, 1.5, 999999, BALANCE_DISPLAY_MAX, BALANCE_DISPLAY_MAX + 1, Number.NaN]) {
      const failure = balanceDisplayFailure(points);
      let threw = false;
      try {
        formatBalance(points);
      } catch (err: unknown) {
        threw = err instanceof BalanceNotDisplayableError;
        // And the thrown reason is the predicate's reason, not a paraphrase.
        if (err instanceof BalanceNotDisplayableError) {
          expect(err.message).toContain(failure ?? '');
        }
      }
      expect(threw).toBe(failure !== null);
    }
  });
});
