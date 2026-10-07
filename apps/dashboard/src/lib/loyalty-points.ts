/**
 * The arithmetic behind a points preview, and the mechanic it belongs to.
 *
 * It lives here, out of the page, because `apps/dashboard/vitest.config.ts` sets
 * no `environment` and the dashboard therefore runs in `node`: a component
 * cannot be rendered, so any arithmetic left inside one is untestable arithmetic.
 *
 * ## This is an estimate, and it is not the charge
 *
 * `POST /v1/loyalty/points/assign` takes the BASE amount and applies the rates
 * itself — `effectivePoints = Math.floor(base * earnRate * tierMultiplier)`. This
 * module reproduces that product to show the cashier roughly what the customer is
 * earning, and that is the whole of its job.
 *
 * Its output must never be sent back as the base. Doing so applies the tier
 * twice, which is what the POS used to do: a Gold customer (`×2`) was credited
 * `base × rate × 2 × 2`, and because that number is what lands in
 * `points_transactions.points` with `balance_after` accumulated from it, the
 * inflated balance is permanent.
 *
 * It can disagree with the charge, and that is correct. The tier is resolved by
 * the server at the moment of the charge and can change between the preview and
 * the charge — the estimate is built from the rate and tier this client happens
 * to be holding. So callers show this number labelled as an estimate, and the
 * receipt shows what the server decided instead.
 *
 * ## Which mechanic decides what
 *
 * The worker's `base` is not the same number under both accumulation mechanics,
 * and neither is the body field it reads (see `earnBase`). `previewPoints` is the
 * rate × tier product they share; `resolveEarn` is the branch above it.
 *
 * ## A visit is a count, and a count is not money
 *
 * Under `earn_by: 'visit'` the honest value at a counter is "a visit happened".
 * The POS used to send the peso subtotal as that count, which was two things wrong
 * at once: the worker requires a positive **integer**
 * (`!Number.isInteger(points) || points < 1`), and every price in the menu ends in
 * `.50` — so half of all sales came back 400. Rounding the subtotal would not have
 * been the fix either; it would make a `$3.50` latte count as four visits.
 *
 * So the two facts are now separate inputs to `earnBase`, and the mechanic picks
 * the one it is defined in. `pesos` is only read by `purchase`; `visits` is only
 * read by `visit`. See `VISITS_PER_CHARGE`.
 */

import type { EarnRule } from './loyalty-earn-rule';
import { usableEarnRate, usableUnitAmount } from './loyalty-earn-rule';

/**
 * How many qualifying visits one redeemed sale or check-in is worth.
 *
 * ## One, and it is a decision rather than a computation
 *
 * Not `Math.round(subtotal)`, not `Math.ceil(subtotal)`: a peso total is a money
 * amount, and converting one into the other is what put `3.5` in a field that
 * requires a whole number. A `$3.50` latte and a `$5.500` sandwich are both one
 * visit — the customer came once.
 *
 * This is the `visit` mechanic's meaning, so it lives in one named place rather
 * than as a literal at each call site. Every existing tenant is on `visit`, so this
 * changes what each of them credits; balances already in `points_transactions` were
 * written under the old reading and are test data, left exactly as they are.
 */
export const VISITS_PER_CHARGE = 1;

/**
 * The two facts a charge has, in the units each mechanic actually reads.
 *
 * Both are held because the mechanic decides which one is the base — the caller
 * knows the amount on the counter and knows how many qualifying visits the sale
 * represents, and it is not the caller's job to guess which of those the tenant's
 * program pays on. Under `purchase` the count is irrelevant; under `visit` the
 * money is.
 */
export interface EarnSale {
  /** What the sale came to, in pesos. The base under `purchase`. */
  pesos: number;
  /** Qualifying visits this sale represents. The base under `visit`. */
  visits: number;
}

export function previewPoints(base: number, earnRate: number, multiplier: number): number {
  return Math.floor(base * earnRate * multiplier);
}

/**
 * The mechanic-dependent half of an accumulation.
 *
 * ## Which body field the worker consumes
 *
 * `POST /v1/loyalty/points/assign` branches on the tenant's `earn_by`
 * (`workers/growth/src/routes.ts`, §"Who computes the points") and the two fields
 * are mutually exclusive. A `purchase` program that receives `points` is refused
 * with `AMOUNT_REQUIRED`; a `visit` program that receives `amount_pesos` is refused
 * with `VISIT_COUNT_REQUIRED`. Sending both is refused under either mechanic.
 *
 * The POS used to send `points` unconditionally, with a subtotal in pesos as its
 * value. That was a 400 for any `purchase` tenant, and — because the worker
 * requires that count to be an integer — a 400 for half of all `visit` sales too.
 */

/** The single body field a mechanic consumes from the request. */
export type EarnInputField = 'points' | 'amount_pesos';

export interface EarnAssignment {
  /**
   * Which field this sale has to travel in.
   *
   * A fact about the tenant's program, not about the sale, so it is resolved once
   * from the config and cannot vary per charge.
   */
  inputField: EarnInputField;
  /**
   * What the request is worth in the program's unit, *before* the rate and the
   * tier bonus. Never sent — see `previewPoints` — but the estimate is this
   * number's product, so it is what the caller shows when it wants to explain.
   */
  base: number;
  /**
   * The estimate for the cashier: what the worker will credit if the tier has not
   * moved between this render and the charge.
   */
  preview: number;
}

/**
 * How the worker arrives at `base`, from what the counter has in hand.
 *
 * Mirrors the two `base = …` lines in `workers/growth/src/routes.ts`:
 *
 *   visit    → the count, used as-is. There is no amount to convert, and
 *              inventing one would be a lie about what the cashier saw.
 *   purchase → the money over the tenant's unit, so `base` is how many units of
 *              `earn_rate` the amount bought.
 *
 * The other half of each sale is not read. `purchase` ignores `visits` because a
 * visit count is not money, and `visit` ignores `pesos` because a peso total is not
 * a count — reading it was what made every `.50` sale fail the worker's integer
 * guard.
 */
export function earnBase(rule: EarnRule, sale: EarnSale): number {
  return rule.earnBy === 'purchase'
    ? sale.pesos / usableUnitAmount(rule.earnUnitAmount)
    : sale.visits;
}

/**
 * One decision for a sale: which field to send, and what to show for it.
 *
 * The preview and the request were two independent decisions, which is how they
 * came to disagree: the preview rated pesos as if they were a visit count, while
 * the request sent the same pesos under a field the worker may not even read. The
 * cashier was shown one number and the ledger was written from another. Resolving
 * both from the same rule is the whole point — a caller that computes the estimate
 * by one route and the charge by another is exactly the bug this replaces.
 *
 * `sale` is what the counter holds: a subtotal in pesos, and how many qualifying
 * visits it represents. Under `visit` only the second is the base; under `purchase`
 * only the first is.
 */
export function resolveEarn(
  rule: EarnRule,
  sale: EarnSale,
  multiplier: number,
): EarnAssignment {
  const base = earnBase(rule, sale);

  return {
    inputField: rule.earnBy === 'purchase' ? 'amount_pesos' : 'points',
    base,
    preview: previewPoints(base, usableEarnRate(rule.earnRate), multiplier),
  };
}