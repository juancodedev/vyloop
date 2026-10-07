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
 */

import type { EarnBy } from './api';

/** What the worker falls back to when no program row exists. Mirrors its own default. */
const DEFAULT_UNIT_AMOUNT = 1000;

/** Mirrors `MAX_EARN_RATE` in `workers/growth/src/routes.ts`. */
const MAX_EARN_RATE = 1000;

export interface EarnRule {
  earnBy: EarnBy;
  earnRate: number;
  earnUnitAmount: number;
}

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
 * The money amount, or the worker's default when it is unusable.
 *
 * An unusable unit must never reach the screen as `$NaN` or `$0`: the worker
 * refuses a purchase program whose unit it cannot read, so a screen that renders
 * one is describing a program that cannot run.
 */
export function formatUnitAmount(amount: number): string {
  const usable =
    Number.isFinite(amount) && amount > 0 && amount <= 10_000_000 ? amount : DEFAULT_UNIT_AMOUNT;
  return formatPesos(usable);
}

/**
 * The rate, or the worker's fallback of 1 when it is unusable.
 *
 * `earn_rate: 0`, a negative and `NaN` are all refused with `INVALID_EARN_RATE`
 * on write, and a rate above `MAX_EARN_RATE` is refused too. Rendering one would
 * describe a program the API will not store.
 */
export function formatEarnRate(rate: number): string {
  const usable = Number.isFinite(rate) && rate > 0 && rate <= MAX_EARN_RATE ? rate : 1;
  return usable.toLocaleString('es-CL', { maximumFractionDigits: 4 });
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

  return {
    headline: `${rate} ${points} por cada visita`,
    detail: `Cada visita o conteo válido otorga ${rate} ${points} base. El total se multiplica por su nivel y se redondea hacia abajo.`,
  };
}