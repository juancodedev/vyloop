/**
 * The merchant-facing sentence for the accumulation rule.
 *
 * ## Why this is a module
 *
 * The config screen used to hardcode "1 punto por cada $1.000" and "Por cada
 * $1.000 pesos de compra…". Neither was true: `earn_rate` existed, but nothing in
 * the system converted money into points. The earn route multiplied a
 * *caller-supplied* point count by that rate, so the balance was decided by
 * whichever integration made the call while the screen promised the merchant it
 * was decided by their spend.
 *
 * The promise is the part that has to be right. A merchant sets prices and
 * margins against what this sentence says, so the sentence is derived from the
 * rule the worker actually runs rather than written next to it. `lib/loyalty-
 * points.ts` already establishes this split in this package: the dashboard runs
 * in `node`, so a decision left inside a component is untestable.
 *
 * ## The rule it describes (`docs/17-Estrategia-Competitiva.md` §7.5)
 *
 * `earn_by = 'visit'`    `earnRate` is points per qualifying count. The caller
 *                        supplies the count. "9 cafés y el 10 gratis".
 * `earn_by = 'purchase'` `earnRate` is points per `earnUnitAmount` pesos. The
 *                        caller supplies the amount and the worker derives the
 *                        points.
 *
 * Both are floored and both are multiplied by the customer's tier multiplier by
 * `POST /v1/loyalty/points/assign`, which is why the detail sentence mentions the
 * level in both cases.
 *
 * ## What a visit is, in a sentence a merchant can act on
 *
 * The `visit` wording has to answer one question a merchant will otherwise have to
 * guess at: *what counts as one visit?* The answer is a redeemed sale or a check-in,
 * and the amount of that sale is not part of it — a `$3.50` coffee and a `$5.500`
 * sandwich are both one. That is why this branch says "conteo" and never mentions
 * money, and why the caller sends a count rather than a peso total: the worker
 * refuses a non-integer count, so a merchant who believed the mechanic was priced
 * would be told the sale failed for a reason no screen explained.
 */

import type { EarnBy } from './api';

/** What the worker falls back to when no program row exists. Mirrors its own default. */
const DEFAULT_UNIT_AMOUNT = 1000;

/** What the worker falls back to when no rate can be read. Mirrors `resolveEarnRate`. */
const DEFAULT_EARN_RATE = 1;

/** Mirrors `MAX_EARN_RATE` in `workers/growth/src/routes.ts`. */
const MAX_EARN_RATE = 1000;

/** Mirrors `MAX_EARN_UNIT_AMOUNT` in `workers/growth/src/routes.ts`. */
const MAX_EARN_UNIT_AMOUNT = 10_000_000;

export interface EarnRule {
  earnBy: EarnBy;
  earnRate: number;
  earnUnitAmount: number;
}

/**
 * The program as the worker sees it when nothing could be read.
 *
 * `DEFAULT_EARN_BY` and `earn_unit_amount`'s `1000.00` come from
 * `workers/growth/src/routes.ts`. A POS that failed to load its config must fall
 * back to the same program the worker will charge against, and `visit` is the
 * mechanic that has been live since before `earn_by` existed — so a load failure
 * cannot silently turn a sale into a money amount.
 */
export const DEFAULT_EARN_RULE: EarnRule = {
  earnBy: 'visit',
  earnRate: DEFAULT_EARN_RATE,
  earnUnitAmount: DEFAULT_UNIT_AMOUNT,
};

export interface EarnRuleDescription {
  /** One line: the rate, and the thing it is a rate of. */
  headline: string;
  /** One sentence: how a customer's own tier changes it. */
  detail: string;
}

/** `1000` -> `$1.000`. Chilean grouping, and no decimal tail for whole pesos. */
function formatPesos(amount: number): string {
  const hasCents = Math.abs(amount % 1) > 1e-9;
  return `$${amount.toLocaleString('es-CL', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The money amount as a number, or the worker's default when it is unusable.
 *
 * Split out of `formatUnitAmount` so the *wording* on the config screen and the
 * *arithmetic* in the POS preview are decided by the same validity rule. Two
 * predicates for one column is how a screen ends up promising `$1.000` while the
 * estimate divides by something else.
 *
 * ## This fallback is deliberately weaker than the worker's
 *
 * `parseEarnUnitAmount` returns `null` for an unusable unit and
 * `POST /v1/loyalty/points/assign` then **refuses the sale** with
 * `INVALID_EARN_UNIT_AMOUNT`, because paying out against a guessed unit pays real
 * money's worth of points. This function falls back to `1000` instead, because a
 * screen has to render *something*: `$NaN` is not a state a merchant can act on.
 *
 * So the consequence is stated rather than hidden — an unusable unit makes the
 * preview an estimate against the default, and the charge still fails at the
 * worker with the real reason. Guessing the balance locally is not an option
 * either: the base is never sent, so there is no number here that could reach
 * `points_transactions.points`.
 */
export function usableUnitAmount(amount: number): number {
  return Number.isFinite(amount) && amount > 0 && amount <= MAX_EARN_UNIT_AMOUNT
    ? amount
    : DEFAULT_UNIT_AMOUNT;
}

/**
 * The rate as a number, or the worker's fallback of 1 when it is unusable.
 *
 * The same reason as `usableUnitAmount`, and the arithmetic reason matters more
 * here: the worker multiplies a `NaN` rate straight into
 * `points_transactions.points`, and this client refuses to *show* one — so a
 * preview built from the raw rate would print `NaN` for a program the worker will
 * happily charge at rate 1.
 */
export function usableEarnRate(rate: number): number {
  return Number.isFinite(rate) && rate > 0 && rate <= MAX_EARN_RATE ? rate : DEFAULT_EARN_RATE;
}

/**
 * The money amount, or the worker's default when it is unusable.
 *
 * An unusable unit must never reach the screen as `$NaN` or `$0`: the worker
 * refuses a purchase program whose unit it cannot read, so a screen that renders
 * one is describing a program that cannot run.
 */
export function formatUnitAmount(amount: number): string {
  return formatPesos(usableUnitAmount(amount));
}

/**
 * The rate, or the worker's fallback of 1 when it is unusable.
 *
 * `earn_rate: 0`, a negative and `NaN` are all refused with `INVALID_EARN_RATE`
 * on write, and a rate above `MAX_EARN_RATE` is refused too. Rendering one would
 * describe a program the API will not store.
 */
export function formatEarnRate(rate: number): string {
  return usableEarnRate(rate).toLocaleString('es-CL', { maximumFractionDigits: 4 });
}

function pluralizePoints(rate: number, singular: string, plural: string): string {
  return Math.abs(rate - 1) < 1e-9 ? singular : plural;
}

/**
 * The sentence a merchant reads, built from the rule the worker runs.
 *
 * Every branch is stated in the mechanic's own terms. A `visit` program says
 * nothing about money: there is no amount in it, and a sentence that mentions
 * pesos under `visit` is the exact defect this function replaces.
 */
export function describeEarnRule(rule: EarnRule): EarnRuleDescription {
  const rate = formatEarnRate(rule.earnRate);

  if (rule.earnBy === 'purchase') {
    const unit = formatUnitAmount(rule.earnUnitAmount);
    const points = pluralizePoints(Number(rate.replace(',', '.')), 'punto', 'puntos');

    return {
      headline: `${rate} ${points} por cada ${unit} de compra`,
      detail: `Por cada ${unit} de compra, el cliente recibe ${rate} ${points} base. El total se multiplica por su nivel y se redondea hacia abajo.`,
    };
  }

  const points = pluralizePoints(Number(rate.replace(',', '.')), 'punto', 'puntos');

  // "Conteo" rather than "visita" alone, because a merchant registers check-ins and
  // manual counts as well as sales. And the "no depende del monto" clause is not
  // decoration: it is the one fact that tells a merchant why two very different
  // tickets credit the same, and it is the same fact that keeps the caller from
  // sending a peso total where a whole number is required.
  return {
    headline: `${rate} ${points} por cada visita`,
    detail: `Cada visita, venta cobrada o conteo válido otorga ${rate} ${points} base. No depende del monto de la compra. El total se multiplica por su nivel y se redondea hacia abajo.`,
  };
}