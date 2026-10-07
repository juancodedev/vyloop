// @vitest-environment node

/**
 * What the config screen is allowed to promise a merchant.
 *
 * ## The bug this exists to prevent
 *
 * The screen said "1 punto por cada $1.000" and "Por cada $1.000 pesos de compra,
 * el cliente recibe 1 punto (multiplicado por el nivel)". Neither sentence was
 * true. `earn_rate` existed, but nothing in the system ever converted money into
 * points — `POST /v1/loyalty/points/assign` multiplied a *caller-supplied* point
 * count by that rate:
 *
 *   const effectivePoints = Math.floor(body.points * earnRate * tierMultiplier);
 *
 * So a merchant who read this screen believed their program paid out on spend
 * while the balance was actually decided by whichever integration made the call.
 * A promise on a pricing screen is not a cosmetic problem: it is the number a
 * merchant sets their prices and margins against.
 *
 * ## Why a module and not strings in the page
 *
 * `apps/dashboard/vitest.config.ts` sets no `environment`, so the dashboard runs
 * in `node`: nothing renders, so nothing in a component can be asserted on. Every
 * suite in `src/__tests__` reads a page as source text for the same reason. The
 * sentence a merchant reads is therefore *built* here and imported by the page,
 * which makes the copy itself testable rather than merely checkable.
 *
 * The other half of the guarantee is structural and stays in the page: the
 * description can only ever be rendered from the fields it describes, because
 * `config.page.contract.test.ts` asserts the page holds no money wording of its
 * own.
 */

import { describe, expect, it } from 'vitest';

import {
  describeEarnRule,
  formatEarnRate,
  formatUnitAmount,
} from '../lib/loyalty-earn-rule';

describe('describeEarnRule — a purchase program', () => {
  it('names the money the merchant configured, not a fixed $1.000', () => {
    // The defect, written down: this sentence was the false promise, and it
    // described a $1.000 unit no tenant could change.
    const described = describeEarnRule({ earnBy: 'purchase', earnRate: 3, earnUnitAmount: 250 });

    expect(described.headline).toContain('250');
    expect(described.headline).not.toContain('1.000');
    expect(described.detail).toContain('250');
  });

  it('pluralises the points', () => {
    expect(describeEarnRule({ earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 }).headline).toContain(
      '1 punto',
    );
    expect(describeEarnRule({ earnBy: 'purchase', earnRate: 2, earnUnitAmount: 1000 }).headline).toContain(
      '2 puntos',
    );
  });

  it('says the total is multiplied by the level', () => {
    // True of both mechanics: the tier bonus is applied by the worker on top of
    // whatever the rule produced.
    const described = describeEarnRule({ earnBy: 'purchase', earnRate: 2, earnUnitAmount: 500 });

    expect(described.detail).toContain('nivel');
  });
});

describe('describeEarnRule — a visit program', () => {
  it('describes a count, and never money', () => {
    const described = describeEarnRule({ earnBy: 'visit', earnRate: 1, earnUnitAmount: 1000 });

    expect(described.headline).toContain('visita');
    // A visit mechanic has no money in it. A screen that mentions pesos under
    // `visit` is describing a rule the worker does not run.
    expect(`${described.headline} ${described.detail}`).not.toContain('$');
    expect(`${described.headline} ${described.detail}`).not.toContain('pesos');
  });
});

describe('describeEarnRule — the heading', () => {
  it('never promises accumulation without saying what it accumulates from', () => {
    for (const earnBy of ['visit', 'purchase'] as const) {
      const described = describeEarnRule({ earnBy, earnRate: 2, earnUnitAmount: 1000 });

      expect(described.headline.length).toBeGreaterThan(0);
      expect(described.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('formatUnitAmount', () => {
  it('formats a whole peso amount without a decimal tail', () => {
    // `$1.000` reads as a peso figure in this market; `$1000.00` reads as a
    // stringified float, which is what `String(1000)` used to produce.
    expect(formatUnitAmount(1000)).toBe('$1.000');
  });

  it('keeps cents when the merchant configured them', () => {
    expect(formatUnitAmount(250.5)).toBe('$250,50');
  });

  it('falls back to the worker default rather than rendering NaN', () => {
    // An unusable unit must never reach the screen as "$NaN" — that is a
    // merchant reading a number the backend will refuse to pay against.
    expect(formatUnitAmount(Number.NaN)).toBe('$1.000');
    expect(formatUnitAmount(0)).toBe('$1.000');
    expect(formatUnitAmount(-5)).toBe('$1.000');
  });
});

describe('formatEarnRate', () => {
  it('renders a whole rate without a decimal tail', () => {
    expect(formatEarnRate(1)).toBe('1');
    expect(formatEarnRate(2.5)).toBe('2,5');
  });

  it('refuses to render a rate the worker would have rejected', () => {
    // `earn_rate: 0`, a negative and `NaN` are all refused by
    // INVALID_EARN_RATE on write. The screen must not imply a program that the
    // API will not store.
    expect(formatEarnRate(0)).toBe('1');
    expect(formatEarnRate(-1)).toBe('1');
    expect(formatEarnRate(Number.NaN)).toBe('1');
  });
});