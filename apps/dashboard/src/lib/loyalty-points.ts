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
 */

import type { EarnRule } from './loyalty-earn-rule';
import { usableEarnRate, usableUnitAmount } from './loyalty-earn-rule';

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
 * value. That is the right call for a `visit` program — which is all of them today,
 * since `earn_by` defaults to `visit` — and a 400 for any `purchase` tenant.
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
 * How the worker arrives at `base`, from the amount the counter has in hand.
 *
 * Mirrors the two `base = …` lines in `workers/growth/src/routes.ts`:
 *
 *   visit    → the count, used as-is. There is no amount to convert, and
 *              inventing one would be a lie about what the cashier saw.
 *   purchase → the money over the tenant's unit, so `base` is how many units of
 *              `earn_rate` the amount bought.
 *
 * Under `visit` the POS's `amount` argument is the count it sends. That is the
 * behaviour this preserves, not a claim that a peso total is a visit count — a
 * separate question from which field the program reads.
 */
export function earnBase(rule: EarnRule, amount: number): number {
  return rule.earnBy === 'purchase' ? amount / usableUnitAmount(rule.earnUnitAmount) : amount;
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
 * `amount` is whatever the counter holds: a subtotal in pesos, which under
 * `visit` is the count that travels as `points`.
 */
export function resolveEarn(rule: EarnRule, amount: number, multiplier: number): EarnAssignment {
  const base = earnBase(rule, amount);

  return {
    inputField: rule.earnBy === 'purchase' ? 'amount_pesos' : 'points',
    base,
    preview: previewPoints(base, usableEarnRate(rule.earnRate), multiplier),
  };
}