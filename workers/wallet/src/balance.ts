/**
 * Balance formatting for the pass (T6).
 *
 * `LoyaltyPoints.balance` is a **string** with a recommended maximum of 7
 * characters so the value is not truncated on small screens. Formatting with
 * thousands separators spends two of those seven characters on decoration
 * (`96.942` is 6 characters for 5 digits), which collapses the usable ceiling
 * by an order of magnitude. So the format is plain digits with no separators.
 *
 * With 7 characters the format holds to 9,999,999. Past that the display
 * strategy has to change: use `secondaryLoyaltyPoints` (a second labelled
 * row), or move the balance into a `textModulesData` row, or adopt a custom
 * layout. Silently truncating to the top 7 digits would show a member
 * `9999999` when they hold 12345678, which is worse than an error: a wrong
 * balance at a till is a support incident and a trust problem.
 */

/** Google's recommended maximum length for `LoyaltyPoints.balance`. */
export const BALANCE_DISPLAY_MAX_LENGTH = 7;

/**
 * The largest balance the no-separator format can display within
 * `BALANCE_DISPLAY_MAX_LENGTH` characters. This is a formatting ceiling, not a
 * loyalty ceiling: nothing in the ledger stops a customer from earning more.
 */
export const BALANCE_DISPLAY_MAX = 9_999_999;

/** Thrown when a balance cannot be rendered in the primary balance row. */
export class BalanceNotDisplayableError extends Error {
  readonly points: number;

  constructor(points: number, reason: string) {
    super(
      `Balance ${points} cannot be rendered in loyaltyPoints.balance: ${reason}. ` +
        `The no-separator format holds to ${BALANCE_DISPLAY_MAX} points ` +
        `(${BALANCE_DISPLAY_MAX_LENGTH} characters). Beyond that the pass needs ` +
        'secondaryLoyaltyPoints, a textModulesData row, or a custom layout — ' +
        'this must be an explicit product decision, never a silent truncation.',
    );
    this.name = 'BalanceNotDisplayableError';
    this.points = points;
  }
}

/**
 * Why `points` cannot be rendered in the primary balance row, or `null` when it
 * can.
 *
 * ## One rule, two callers
 *
 * `formatBalance` throws on a non-null answer, and `GET /v1/wallet/status` reads
 * the same answer to decide whether the Add to Wallet control would work before
 * rendering it. Both call **this**, so there is exactly one statement of the
 * ceiling in this repository. A second threshold check written at the route
 * would be a second answer to the same question, and the two would eventually
 * disagree — the route would promise a button that the builder then refuses,
 * which is precisely the failure the status endpoint exists to prevent.
 *
 * The order of the checks is the order of the claims: a value that is not a
 * number is not a balance, a fractional one has no representation on a pass that
 * shows integers, a negative one is a data fault rather than a display limit,
 * and only then does the character budget come into it.
 */
export function balanceDisplayFailure(points: number): string | null {
  if (!Number.isFinite(points)) {
    return 'the value is not a finite number';
  }
  if (!Number.isInteger(points)) {
    return 'the value is fractional and the pass shows integers';
  }
  if (points < 0) {
    return 'a negative balance has no representation in loyaltyPoints.balance';
  }
  if (points > BALANCE_DISPLAY_MAX) {
    return `${String(points).length} digits exceeds the ${BALANCE_DISPLAY_MAX_LENGTH}-character budget`;
  }
  return null;
}

/**
 * Render a points balance for `loyaltyPoints.balance`.
 *
 * @throws {BalanceNotDisplayableError} for a non-finite, fractional, negative
 * or over-ceiling value.
 */
export function formatBalance(points: number): string {
  const failure = balanceDisplayFailure(points);
  if (failure !== null) {
    throw new BalanceNotDisplayableError(points, failure);
  }

  // `Number.prototype.toLocaleString` is avoided entirely: the Workers ICU
  // build is not guaranteed to be present, and any locale-aware path is one
  // comma away from producing a thousands separator.
  return String(points);
}
