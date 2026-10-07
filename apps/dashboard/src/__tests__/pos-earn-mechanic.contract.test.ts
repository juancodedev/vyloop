// @vitest-environment node

/**
 * The POS speaks the tenant's accumulation mechanic, and says which one it used.
 *
 * ## The bug
 *
 * `POST /v1/loyalty/points/assign` reads the tenant's `loyalty_programs.earn_by`
 * and consumes a DIFFERENT body field per mechanic (`workers/growth/src/routes.ts`
 * §"Who computes the points"):
 *
 *   earn_by = 'visit'    → `points` is a qualifying count. An `amount_pesos`
 *                           alongside it is refused with `VISIT_COUNT_REQUIRED`.
 *   earn_by = 'purchase' → `amount_pesos` is the money, and the points are
 *                           derived from it. A caller-supplied `points` is refused
 *                           with `AMOUNT_REQUIRED`.
 *
 * The POS knew none of this. It sent `points: subtotal` — a number of pesos
 * dressed as a count of visits — so a `purchase` tenant gets a 400 at the moment
 * of the charge, in front of a customer, on the one screen a cashier cannot
 * afford to have fail. Its preview had the same cause: `previewPoints(subtotal,
 * earnRate, multiplier)` treats pesos as a visit count, so the estimate was wrong
 * by the unit division (`/1.000`) even on the cases that did not 400.
 *
 * Under `visit` the same lie was a 400 of its own, and a louder one: the worker
 * requires that count to be an **integer** (`!Number.isInteger(points) || points < 1`),
 * and every price in the demo menu ends in `.50`, so half of all sales were refused.
 * Rounding the subtotal would not have fixed it either — that only moves the lie
 * one peso to the left, and makes a `$3.50` latte count as four visits.
 *
 * No tenant is on `purchase` yet, which is exactly why this sat: every existing
 * program is `visit`, and under `visit` a whole-peso sale was a 201.
 *
 * ## What a visit credits, and where that number comes from
 *
 * **One redeemed sale or check-in is one visit.** Not `Math.round(subtotal)`, not
 * `Math.ceil(subtotal)`: a peso total is a money amount, and calling it a count is
 * what produced both the 400 and the inflated balances. The count is a fact about
 * the *event*, not about its price, so it originates in exactly one place —
 * `VISITS_PER_CHARGE` in `lib/loyalty-points.ts`, which the POS hands to
 * `earnBase` as the `visits` half of the sale it describes.
 *
 * This is a product decision, accepted deliberately for every existing tenant: a
 * `$3.50` latte and a `$5.50` sandwich are both one visit. Balances already in
 * `points_transactions` are left exactly as they are — they are test data.
 *
 * ## What is pinned here, and how
 *
 * The worker is right; the caller was wrong. So this file pins the *caller*:
 *
 *  1. **The base**, transcribed independently and then checked against the real
 *     `base = …` lines in the worker, so the arithmetic cannot drift into agreeing
 *     with a bug of its own.
 *  2. **The field**, per mechanic — because the two are mutually exclusive and a
 *     body carrying both is a 400 in either direction.
 *  3. **The estimate**, computed from the same rule the charge uses. The preview
 *     and the request used to be two independent decisions; they are now one.
 *  4. **What the POS actually sends**, asserted on the real `fetch` calls
 *     `lib/api.ts` makes — `lookup-customer.contract.test.ts` established that
 *     this module is plain `fetch` and can be stubbed, so no test here scrapes a
 *     request body out of source text.
 *
 * Structure, not rendering: `vitest.config.ts` sets no `environment`, so the
 * dashboard runs in `node` and nothing renders. The few page assertions read the
 * component as text, which is what `loyalty-points.contract.test.ts` and
 * `pos-pass-badge.contract.test.ts` already do.
 */

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api';
import {
  earnBase,
  resolveEarn,
  VISITS_PER_CHARGE,
  type EarnSale,
} from '../lib/loyalty-points';

const posSource = readFileSync(
  new URL('../app/dashboard/loyalty/pos/page.tsx', import.meta.url).pathname,
  'utf8',
);
// The customer detail page has its own manual "Registrar Venta" modal. It is
// another work unit's page and this file does not redesign it — but it sends the
// same field, so leaving it out of here would mean the mechanic is only correct in
// one of the two places a sale is recorded.
const customerSource = readFileSync(
  new URL('../app/dashboard/customers/[id]/page.tsx', import.meta.url).pathname,
  'utf8',
);
const growthSource = readFileSync(
  new URL('../../../../workers/growth/src/routes.ts', import.meta.url).pathname,
  'utf8',
);

// ─── Source readers ────────────────────────────────────────────────────

/**
 * The page with its prose removed.
 *
 * JSX blocks, block comments and whole-line `//` comments, in that order. Used
 * only where an assertion is about *code* — "does not call this" — because a page
 * that explains the call it removed is doing the right thing, not the wrong one.
 * A `//` is only dropped at the start of a line, so a URL inside a string survives.
 */
function posCode(): string {
  return posSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

// ─── The worker contract, transcribed ──────────────────────────────────

/** `floor(base * earnRate * tierMultiplier)` — the worker's one formula. */
function workerEffectivePoints(base: number, earnRate: number, multiplier: number): number {
  return Math.floor(base * earnRate * multiplier);
}

/**
 * How the worker arrives at `base`, before the shared formula multiplies it.
 *
 *   visit    → the caller's count, used as-is: there is no amount to convert.
 *   purchase → the money divided by the tenant's unit, so `base` is how many
 *              units of `earn_rate` the amount bought.
 *
 * Transcribed from `workers/growth/src/routes.ts` (`base = amount / unit;` under
 * `purchase`, `base = points;` under the visit branch), so this is the worker's
 * arithmetic and not the dashboard's opinion of it.
 */
function workerBase(earnBy: 'visit' | 'purchase', amount: number, unit: number): number {
  return earnBy === 'purchase' ? amount / unit : amount;
}

/**
 * The same derivation, fed the value the mechanic is defined in.
 *
 * `visit` reads the count, `purchase` reads the money. Spelling that out here is
 * the point: a transcription that took pesos for both would agree with the
 * dashboard while describing a different worker.
 */
function workerBaseFor(
  earnBy: 'visit' | 'purchase',
  sale: EarnSale,
  unit: number,
): number {
  return workerBase(earnBy, earnBy === 'purchase' ? sale.pesos : sale.visits, unit);
}

/** One redeemed sale, as the two facts a counter actually holds. */
function saleOf(pesos: number, visits = VISITS_PER_CHARGE): EarnSale {
  return { pesos, visits };
}

// ─── The requests the helpers really send ──────────────────────────────

interface Sent {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

let sent: Sent[] = [];

function respondWith(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify(body), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

const ASSIGN_OK = { data: { id: 'tx-1', points: 12, balance_after: 300 } };

afterEach(() => {
  sent = [];
  vi.unstubAllGlobals();
});

/** The one request body of the last assign call. */
function lastAssignBody(): Record<string, unknown> {
  const assigns = sent.filter((call) => call.url.includes('/v1/loyalty/points/assign'));
  expect(assigns, 'no /v1/loyalty/points/assign call was made').toHaveLength(1);
  return assigns[0]!.body;
}

/**
 * Whether the worker would accept this body for this program.
 *
 * A transcription of the two guards at the top of
 * `POST /v1/loyalty/points/assign` (`workers/growth/src/routes.ts`): a `purchase`
 * program needs a usable `amount_pesos` and no count; a `visit` program needs the
 * reverse. Written as a boolean rather than a response code because the point is
 * the *shape*, and a code would only restate which error the cashier sees.
 */
function workerAccepts(earnBy: 'visit' | 'purchase', body: Record<string, unknown>): boolean {
  if (earnBy === 'purchase') {
    const amount = Number(body.amount_pesos);
    return Number.isFinite(amount) && amount > 0 && !('points' in body);
  }
  return (
    body.amount_pesos === undefined &&
    Number.isInteger(Number(body.points)) &&
    Number(body.points) >= 1
  );
}

// ─── 1. The base, pinned against the worker's own lines ────────────────

describe('the base the worker derives', () => {
  it('is the visit count under visit, and the money over the unit under purchase', () => {
    expect(earnBase({ earnBy: 'visit', earnRate: 1, earnUnitAmount: 1000 }, saleOf(4000, 1))).toBe(1);
    expect(
      earnBase({ earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 }, saleOf(3000)),
    ).toBe(3);
  });

  it('does not read the peso total under visit, at any price', () => {
    // The defect in one assertion. A `$3.50` latte and a `$5.500` sandwich are
    // both one visit, so a base that moves with the money is wrong for *every*
    // sale — not only the fractional ones the worker happens to reject.
    const rule = { earnBy: 'visit', earnRate: 1, earnUnitAmount: 1000 } as const;

    for (const pesos of [1, 3.5, 4, 5.5, 4000, 99999.99]) {
      expect(earnBase(rule, saleOf(pesos, VISITS_PER_CHARGE)), `$${pesos}`).toBe(
        VISITS_PER_CHARGE,
      );
    }
  });

  it('is always an integer under visit, whatever the money was', () => {
    // `workers/growth/src/routes.ts` refuses a non-integer count with
    // `VALIDATION_ERROR`, so this is the property that keeps half the menu sellable.
    const rule = { earnBy: 'visit', earnRate: 1, earnUnitAmount: 1000 } as const;

    for (const pesos of [3.5, 1.5, 5.5, 4.5, 0.01, 123.45]) {
      const base = earnBase(rule, saleOf(pesos));

      expect(Number.isInteger(base), `$${pesos} produced a non-integer base`).toBe(true);
      expect(base).toBeGreaterThanOrEqual(1);
    }
  });

  it('divides by the tenant’s unit, not by a fixed $1.000', () => {
    // The unit is the merchant's own setting; reading a fixed 1000 is how a
    // 3-points-per-$250 program quietly paid as if it were 1 per $1.000.
    expect(
      earnBase({ earnBy: 'purchase', earnRate: 3, earnUnitAmount: 250 }, saleOf(1000)),
    ).toBe(4);
    expect(
      earnBase({ earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 }, saleOf(1000)),
    ).toBe(1);
  });

  it('matches the two `base = …` lines the worker actually runs', () => {
    // Written independently above; checked against the source here, so a change
    // to the worker's derivation fails here instead of silently agreeing.
    expect(growthSource, 'purchase base').toMatch(/base = amount \/ unit;/);
    expect(growthSource, 'visit base').toMatch(/base = points;/);

    const formula = growthSource.match(/const effectivePoints = ([^;]+);/);
    expect(formula, 'no effectivePoints declaration in the growth worker').not.toBeNull();
    expect(formula![1]!.replace(/\s+/g, ' ').trim()).toBe(
      'Math.floor(base * earnRate * tierMultiplier)',
    );
  });

  it('agrees with the worker on both mechanics', () => {
    for (const [earnBy, pesos, visits, unit] of [
      ['visit', 4000, 1, 1000],
      ['visit', 3.5, 1, 1000],
      ['purchase', 12500, 1, 1000],
      ['purchase', 1000, 1, 250],
    ] as const) {
      const sale = saleOf(pesos, visits);

      expect(earnBase({ earnBy, earnRate: 2, earnUnitAmount: unit }, sale)).toBe(
        workerBaseFor(earnBy, sale, unit),
      );
    }
  });
});

// ─── 2. The field the mechanic consumes ────────────────────────────────

describe('the body field the program consumes', () => {
  it('is `amount_pesos` for a purchase program', () => {
    expect(
      resolveEarn({ earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 }, saleOf(4000), 1)
        .inputField,
    ).toBe('amount_pesos');
  });

  it('is `points` for a visit program', () => {
    // The default mechanic. A change here is a change to every existing tenant.
    expect(
      resolveEarn({ earnBy: 'visit', earnRate: 1, earnUnitAmount: 1000 }, saleOf(4000), 1).inputField,
    ).toBe('points');
  });

  it('carries the count under `points`, and not the peso total', () => {
    // The value the POS hands to `api.assignPoints` is `earn.base`, so this is
    // the assertion that decides what a $5.500 sandwich credits.
    const resolved = resolveEarn({ earnBy: 'visit', earnRate: 2, earnUnitAmount: 1000 }, saleOf(5500), 1);

    expect(resolved.base).toBe(VISITS_PER_CHARGE);
    expect(Number.isInteger(resolved.base)).toBe(true);
  });

  it('still files the money as `amount_pesos` under purchase', () => {
    // The other direction of the same decision: the mechanic that DOES read pesos
    // must keep reading them exactly.
    const resolved = resolveEarn(
      { earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 },
      saleOf(4000),
      1,
    );

    expect(resolved.inputField).toBe('amount_pesos');
    expect(resolved.base).toBe(4);
  });

  it('sends the money as `amount_pesos` and nothing else', async () => {
    respondWith(ASSIGN_OK);
    await api.assignPurchasePoints('cust-1', 4000, 'Venta POS: Latte x1');

    const body = lastAssignBody();

    expect(body.amount_pesos).toBe(4000);
    // Both fields is a 400 in either direction: the worker refuses a caller count
    // next to a money amount, and refuses the amount under a visit program.
    expect(Object.keys(body)).not.toContain('points');
    expect(body.customer_id).toBe('cust-1');
    expect(body.note).toBe('Venta POS: Latte x1');
  });

  it('keeps the visit call sending a count, with no amount beside it', async () => {
    respondWith(ASSIGN_OK);
    await api.assignPoints('cust-1', 7, 'Venta POS: Latte x1');

    const body = lastAssignBody();

    expect(body.points).toBe(7);
    expect(Object.keys(body)).not.toContain('amount_pesos');
  });

  it('gives both mechanics a distinct reference id from the same sale', async () => {
    respondWith(ASSIGN_OK);
    await api.assignPoints('cust-1', 7);
    await api.assignPurchasePoints('cust-1', 7000);

    const ids = sent
      .filter((call) => call.url.includes('/v1/loyalty/points/assign'))
      .map((call) => String(call.body.reference_id));

    // `reference_id` is unique per customer, so two sales that collide on the
    // millisecond are a 409 on the second one.
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^sale-cust-1-\d+$/);
    expect(ids[1]).toMatch(/^sale-cust-1-\d+$/);
  });

  it('posts both mechanics to the same route', async () => {
    respondWith(ASSIGN_OK);
    await api.assignPoints('cust-1', 7);
    await api.assignPurchasePoints('cust-1', 7000);

    for (const call of sent) {
      expect(call.method).toBe('POST');
      expect(call.url).toContain('/v1/loyalty/points/assign');
    }
  });
});

// ─── 3. The estimate follows the rule the charge uses ──────────────────

describe('the preview', () => {
  it('is the money divided by the unit, rated and multiplied', () => {
    // 3 points per $250, ×2 tier, $1.000 sale: 1000/250 = 4 units, 4 × 3 × 2 = 24.
    expect(
      resolveEarn({ earnBy: 'purchase', earnRate: 3, earnUnitAmount: 250 }, saleOf(1000), 2).preview,
    ).toBe(24);
  });

  it('is what the worker will credit, when the tier has not moved', () => {
    for (const [earnBy, pesos, visits, unit, rate, tier] of [
      ['visit', 4000, 1, 1000, 1, 1],
      ['visit', 3.5, 1, 1000, 1.5, 2],
      ['purchase', 12500, 1, 1000, 1, 1],
      ['purchase', 1000, 1, 250, 3, 1.5],
      ['purchase', 1999, 1, 1000, 1, 1],
    ] as const) {
      const sale = saleOf(pesos, visits);
      const resolved = resolveEarn({ earnBy, earnRate: rate, earnUnitAmount: unit }, sale, tier);

      expect(resolved.preview).toBe(
        workerEffectivePoints(workerBaseFor(earnBy, sale, unit), rate, tier),
      );
    }
  });

  it('floors, like the ledger row it estimates', () => {
    // $1.999 at 1 point per $1.000 is 1 unit and a bit; the ledger stores 1.
    expect(
      resolveEarn({ earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 }, saleOf(1999), 1).preview,
    ).toBe(1);
  });

  it('does not apply the tier twice', () => {
    const resolved = resolveEarn(
      { earnBy: 'purchase', earnRate: 2, earnUnitAmount: 1000 },
      saleOf(5000),
      2,
    );

    expect(resolved.preview).toBe(20);
    expect(resolved.preview).not.toBe(workerEffectivePoints(resolved.preview, 2, 2));
  });

  it('rates a visit, not the money behind it', () => {
    // The estimate the cashier reads is now what a `visit` program actually pays
    // for a visit: rate × tier, on a base of one. Rate 1.5 and a ×2 tier: 3.
    //
    // This number moved on purpose. It was 3000 for a $1.000 sale because pesos
    // were being rated as visits, and every balance in the ledger was written from
    // that reading. Those rows are test data and stay as they are.
    const resolved = resolveEarn(
      { earnBy: 'visit', earnRate: 1.5, earnUnitAmount: 1000 },
      saleOf(1000),
      2,
    );

    expect(resolved.base).toBe(1);
    expect(resolved.preview).toBe(3);
    expect(resolved.preview).toBe(workerEffectivePoints(1, 1.5, 2));
  });

  it('is the same for a $1 sale and a $99.999 sale', () => {
    // The property the cashier sees on screen: adding items to the cart must not
    // move the points. Under the old reading it did, linearly.
    const rule = { earnBy: 'visit', earnRate: 1.5, earnUnitAmount: 1000 } as const;

    expect(resolveEarn(rule, saleOf(1), 2).preview).toBe(3);
    expect(resolveEarn(rule, saleOf(99999.99), 2).preview).toBe(3);
  });

  it('is never negative for an empty or refunded cart', () => {
    // Nothing was bought, so nothing is owed. Still a money property, because only
    // `purchase` reads money — and it is the POS that has to not charge at all on
    // an empty cart (`cart.length === 0` returns before any request), so there is
    // no negative count to guard here.
    for (const pesos of [0, -500]) {
      const resolved = resolveEarn(
        { earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 },
        saleOf(pesos),
        1,
      );

      expect(resolved.preview, `$${pesos}`).toBeLessThanOrEqual(0);
    }
  });
});

// ─── 4. Unusable config cannot produce a number nobody can check ───────

describe('an unusable program setting', () => {
  it('falls back to the worker’s own default unit rather than dividing by zero', () => {
    for (const unit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const resolved = resolveEarn(
        { earnBy: 'purchase', earnRate: 1, earnUnitAmount: unit },
        saleOf(2000),
        1,
      );

      expect(Number.isFinite(resolved.base), `unit ${unit}`).toBe(true);
      // 2000 / 1000 — the same default `formatUnitAmount` describes on the config
      // screen, so the sentence and the estimate never disagree.
      expect(resolved.preview).toBe(2);
    }
  });

  it('never reads the money under visit, so it cannot be fractional', () => {
    // The one thing that makes a fractional sale survivable. The unit is not the
    // issue here — a visit program has no unit — the money is not read at all.
    for (const pesos of [3.5, 0.01, 123.45]) {
      const resolved = resolveEarn(
        { earnBy: 'visit', earnRate: 1, earnUnitAmount: Number.NaN },
        saleOf(pesos),
        1,
      );

      expect(Number.isInteger(resolved.base), `$${pesos}`).toBe(true);
    }
  });

  it('falls back to a rate of 1 rather than crediting a NaN estimate', () => {
    for (const rate of [0, -3, Number.NaN]) {
      const resolved = resolveEarn(
        { earnBy: 'purchase', earnRate: rate, earnUnitAmount: 1000 },
        saleOf(1000),
        1,
      );

      expect(Number.isFinite(resolved.preview), `rate ${rate}`).toBe(true);
    }
  });

  it('is never negative for an empty or refunded cart', () => {
    // Nothing was bought, so nothing is owed. Still a money property, because only
    // `purchase` reads money — and it is the POS that has to not charge at all on
    // an empty cart (`cart.length === 0` returns before any request), so there is no
    // negative count to guard here.
    for (const pesos of [0, -500]) {
      const resolved = resolveEarn(
        { earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 },
        saleOf(pesos),
        1,
      );

      expect(resolved.preview, `$${pesos}`).toBeLessThanOrEqual(0);
    }
  });
});

// ─── 5. The request the worker will actually accept ────────────────────

describe('the sale as the worker will read it', () => {
  /**
   * What the POS does for a sale: resolve the mechanic, then send the field that
   * mechanic reads, carrying the value that field is defined in.
   *
   * `earn.base` is the number in the program's own unit, so this is the same
   * expression the page runs — not a transcription of what it used to do.
   */
  async function chargeLikeThePos(
    rule: { earnBy: 'visit' | 'purchase'; earnRate: number; earnUnitAmount: number },
    subtotal: number,
  ): Promise<{ earnBy: 'visit' | 'purchase'; body: Record<string, unknown> }> {
    // One sale per call, so `lastAssignBody`'s single-request assertion means what
    // it says: this sale produced exactly one request.
    sent = [];
    respondWith(ASSIGN_OK);
    const resolved = resolveEarn(rule, saleOf(subtotal), 1);

    if (resolved.inputField === 'amount_pesos') {
      // `purchase` reads money, so it is sent money — the raw subtotal, because the
      // division by the unit is the worker's to do.
      await api.assignPurchasePoints('cust-1', subtotal, 'Venta POS: Latte x1');
    } else {
      // `visit` reads a count, so it is sent a count: one visit per redeemed sale.
      await api.assignPoints('cust-1', resolved.base, 'Venta POS: Latte x1');
    }

    return { earnBy: rule.earnBy, body: lastAssignBody() };
  }

  it('is accepted under a visit program', async () => {
    // The live mechanic, and the one every existing tenant is on. This is the
    // case that must not regress: it was a 201 yesterday and it has to stay one.
    const sale = await chargeLikeThePos(
      { earnBy: 'visit', earnRate: 1, earnUnitAmount: 1000 },
      4000,
    );

    expect(workerAccepts(sale.earnBy, sale.body)).toBe(true);
  });

  it('is accepted under a purchase program', async () => {
    // The 400 this work unit exists to remove, asserted from the other end: what
    // the POS now sends is a body the worker's own guards let through.
    const sale = await chargeLikeThePos(
      { earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 },
      4000,
    );

    expect(sale.body.amount_pesos).toBe(4000);
    expect(workerAccepts(sale.earnBy, sale.body)).toBe(true);
  });

  it('is accepted for every subtotal a whole-peso cart can produce', async () => {
    for (const subtotal of [1, 4, 4000]) {
      for (const earnBy of ['visit', 'purchase'] as const) {
        const sale = await chargeLikeThePos(
          { earnBy, earnRate: 1, earnUnitAmount: 1000 },
          subtotal,
        );

        expect(workerAccepts(earnBy, sale.body), `${earnBy} rejected a $${subtotal} sale`).toBe(
          true,
        );
      }
    }
  });

  it('is accepted for a fractional sale under a purchase program', async () => {
    // Money is not required to be a whole peso, so a $3.50 latte is a valid
    // `amount_pesos` and the conversion happens on the worker's side.
    const sale = await chargeLikeThePos(
      { earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 },
      3.5,
    );

    expect(sale.body.amount_pesos).toBe(3.5);
    expect(workerAccepts(sale.earnBy, sale.body)).toBe(true);
  });

  it('is accepted for a fractional sale under a visit program', async () => {
    // The half of the menu that could not be sold. Every price ends in `.50`, so
    // `551b912`'s integer guard refused half of all sales: $3.50 → `points: 3.5`
    // → 400 VALIDATION_ERROR, in front of a customer.
    //
    // The fix was never in the worker. `Number.isInteger` is correct — a count of
    // visits is a whole number — and the POS was wrong to file a peso subtotal as
    // one. This assertion is the gap closed: the caller sends the count, so the
    // money's cents are the worker's business and not the count's.
    const sale = await chargeLikeThePos(
      { earnBy: 'visit', earnRate: 1, earnUnitAmount: 1000 },
      3.5,
    );

    expect(workerAccepts(sale.earnBy, sale.body)).toBe(true);
    expect(sale.body.points).toBe(VISITS_PER_CHARGE);
    // The peso total is nowhere in the request. It is not in the note either as a
    // count: the note names the items, and the amount stays money all the way.
    expect(String(sale.body.note)).not.toContain('3.5');
  });

  it('is accepted for every price in the demo menu', async () => {
    // The whole `MENU` array from the POS page, read out of the source. A test that
    // lists its own prices proves nothing about the ones a cashier can actually
    // ring up.
    const prices = [...posSource.matchAll(/price:\s*([\d.]+)/g)].map((match) => Number(match[1]));

    expect(prices.length).toBeGreaterThan(10);

    for (const price of prices) {
      const sale = await chargeLikeThePos(
        { earnBy: 'visit', earnRate: 1.5, earnUnitAmount: 1000 },
        price,
      );

      expect(
        workerAccepts(sale.earnBy, sale.body),
        `a $${price.toFixed(2)} sale was refused`,
      ).toBe(true);
    }
  });

  it('credits one visit per sale, whatever the cart was worth', async () => {
    // Three sales, three visits. The number the ledger writes is the tier × rate
    // product of ONE — it no longer scales with the money, which is the whole point.
    for (const subtotal of [1.5, 3.5, 55.5]) {
      const sale = await chargeLikeThePos(
        { earnBy: 'visit', earnRate: 1.5, earnUnitAmount: 1000 },
        subtotal,
      );

      expect(sale.body.points, `$${subtotal}`).toBe(1);
    }
  });

  it('is refused when the two mechanics are crossed — the bug, from the worker’s side', () => {
    // What the POS used to do, judged by the rules the worker runs: a `purchase`
    // tenant received pesos under `points` and got `AMOUNT_REQUIRED`.
    expect(workerAccepts('purchase', { customer_id: 'c', points: 4000 })).toBe(false);
    expect(workerAccepts('visit', { customer_id: 'c', amount_pesos: 4000 })).toBe(false);
    expect(workerAccepts('purchase', { customer_id: 'c', points: 4000, amount_pesos: 4000 })).toBe(
      false,
    );
  });
});

// ─── 6. The page asks which mechanic, and obeys ────────────────────────
describe('the POS page', () => {
  it('resolves the sale through the shared decision', () => {
    expect(posSource).toMatch(
      /import\s*\{[^}]*\bresolveEarn\b[^}]*\}\s*from\s*'@\/lib\/loyalty-points'/,
    );
    expect(posSource).toContain('resolveEarn(');
  });

  it('reads the tenant’s mechanic from the loyalty config it already loads', () => {
    // `earn_by` defaults to `visit`, so a failure to load must not flip the POS
    // into sending money to a program that counts visits.
    expect(posSource).toMatch(/api\.getLoyaltyConfig\(\)/);
    expect(posSource).toContain('earnBy');
    expect(posSource).toContain('earnUnitAmount');
  });

  it('calls one of the two methods, chosen by the program', () => {
    expect(posSource).toContain('api.assignPurchasePoints(');
    expect(posSource).toContain('api.assignPoints(');
  });

  it('sends the raw subtotal as money, and the count as a count', () => {
    // Two different values now, and this is the line that says so:
    //   purchase → the money, unfloored, because the division by the unit is the
    //              worker's to do (`base = amount / unit`).
    //   visit    → `earn.base`, which is the visit count. The page does not send
    //              `subtotal` here any more, and must not: a peso total under
    //              `points` is the bug `551b912`'s integer guard exposed.
    expect(posSource).toMatch(/api\.assignPurchasePoints\(\s*customer\.id,\s*subtotal,/);
    expect(posSource).toMatch(/api\.assignPoints\(\s*customer\.id,\s*earn\.base,/);
  });

  it('never sends the peso total as the visit count', () => {
    // The regression, stated as the absence that has to hold: this is what made
    // half the menu unsellable, and it is a one-token change away from coming back.
    const code = posCode();

    expect(code).not.toMatch(/api\.assignPoints\(\s*customer\.id,\s*subtotal\b/);
    expect(code).not.toMatch(/api\.assignPoints\(\s*customer\.id,\s*Math\./);
  });

  it('names the count it sends, instead of writing a literal 1', () => {
    // A bare `api.assignPoints(customer.id, 1, note)` reads as a typo and rots the
    // moment someone adds a second kind of qualifying event. The number comes from
    // `VISITS_PER_CHARGE`, so the decision has a name and one home.
    expect(posSource).toMatch(/VISITS_PER_CHARGE/);
    expect(posSource).not.toMatch(/api\.assignPoints\(\s*customer\.id,\s*1\s*,/);
  });

  it('takes the count from the shared decision, not from the cart', () => {
    // The count is a fact about the sale as an event. Deriving it from the cart —
    // item count, quantity, subtotal — reintroduces money into a count.
    expect(posSource).toMatch(
      /resolveEarn\(\s*earnRule,\s*\{\s*pesos:\s*subtotal,\s*visits:\s*VISITS_PER_CHARGE\s*\}/,
    );
  });

  it('never sends the estimate as either mechanic’s input', () => {
    // The defect `loyalty-points.contract.test.ts` already pins, re-asserted for the
    // method that did not exist when it was written.
    //
    // `earn.base` is allowed now — it is the count under `visit`, and it is the
    // money's own quotient under `purchase`. What may never travel is `preview`:
    // that number already had the rate and the tier multiplied into it, and the
    // worker multiplies them again.
    //
    // Read without the comments: this page's own commentary names the old call it
    // replaced, and a test that greps prose fails the next time somebody explains
    // the bug accurately in a comment.
    const code = posCode();

    expect(code).not.toMatch(/previewPoints\(/);
    for (const forbidden of ['earn.preview', 'previewPoints(', 'pointsToEarn']) {
      const asArgument = code.match(
        new RegExp(`api\\.assign\\w*Points\\([^)]*${forbidden.replace('(', '\\(')}`),
      );
      expect(asArgument?.[0] ?? '', `"${forbidden}" is sent as the base`).not.toContain(forbidden);
    }
  });

  it('still takes the receipt from the server, not from the estimate', () => {
    expect(posSource).toMatch(/pointsEarned:\s*earned\.points/);
  });

  it('states the rule it applied, from the shared wording module', () => {
    // The estimate is only checkable if the screen says what produced it, and the
    // wording already exists in `lib/loyalty-earn-rule.ts` — the config screen's
    // copy, so the two screens cannot describe the same program differently.
    expect(posSource).toMatch(
      /import\s*\{[^}]*\bdescribeEarnRule\b[^}]*\}\s*from\s*'@\/lib\/loyalty-earn-rule'/,
    );
    expect(posSource).toMatch(/describeEarnRule\(/);
  });

  it('does not hardcode money wording of its own', () => {
    // Under `visit` a sentence mentioning pesos is false: there is no amount in
    // the program. The module owns that distinction; the page only places it.
    expect(posSource).not.toMatch(/\d+\s*pesos\s*de\s*compra/i);
    expect(posSource).not.toMatch(/por\s*cada\s*\$/i);
  });
});

// ─── 7. The POS hands the worker the mechanic's own field ──────────────

describe('the estimate the cashier reads under a visit program', () => {
  it('is the rate times the tier, on one visit — not the money', () => {
    // A Gold customer (`×2`) on a 1-point-per-visit program: 2 points for this
    // sale. The number used to be the peso subtotal rated the same way, so a
    // `$1.000` order showed "+2.000" for a latte and a sandwich alike.
    const resolved = resolveEarn(
      { earnBy: 'visit', earnRate: 1, earnUnitAmount: 1000 },
      saleOf(1000),
      2,
    );

    expect(resolved.preview).toBe(2);
  });

  it('is shown from `earn.preview`, which is the one derived number', () => {
    // `pointsToEarn` is a rename of `earn.preview`, not a second computation. Two
    // separate derivations is how the screen and the request came to disagree.
    expect(posSource).toMatch(/const pointsToEarn = earn\.preview;/);
  });
});

// ─── 8. The customer page records a sale too, and speaks the mechanic ────

/**
 * The modal, read as source.
 *
 * Sliced out so the assertions are about this page's manual sale registration and
 * nothing else on it. `apps/dashboard/vitest.config.ts` sets no `environment`, so
 * the dashboard runs in `node` and nothing renders — the established pattern in
 * `loyalty-points.contract.test.ts`.
 */
function customerModal(): string {
  const start = customerSource.indexOf('Registrar Venta');
  expect(start, 'no Registrar Venta modal found').toBeGreaterThan(-1);

  return customerSource.slice(start, customerSource.length);
}

/** The page with its prose removed. Same reason as `posCode()`. */
function customerCode(): string {
  return customerSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

describe('the customer page sale modal', () => {
  it('resolves through the shared decision too', () => {
    // Two places send `POST /v1/loyalty/points/assign`. Deriving only one of them
    // means a tenant whose program is `visit` gets correct sales from the POS and
    // 400s from this modal — the same fractional-peso failure, on a different screen.
    expect(customerSource).toMatch(
      /import\s*\{[^}]*\bresolveEarn\b[^}]*\}\s*from\s*'@\/lib\/loyalty-points'/,
    );
    expect(customerSource).toContain('resolveEarn(');
  });

  it('reads the mechanic, defaulting to visit', () => {
    // `earn_by` defaults to `visit` in the worker, and a failed config load must not
    // flip this page into sending money to a program that counts visits.
    expect(customerSource).toMatch(/api\.getLoyaltyConfig\(\)/);
    expect(customerSource).toContain('earnBy');
    expect(customerSource).toContain('earnUnitAmount');
    expect(customerSource).toMatch(/DEFAULT_EARN_RULE/);
  });

  it('calls the method the mechanic reads', () => {
    expect(customerSource).toContain('api.assignPurchasePoints(');
    expect(customerSource).toContain('api.assignPoints(');
  });

  it('sends the visit count under `visit`, never the peso amount', () => {
    const code = customerCode();

    expect(code).not.toMatch(/api\.assignPoints\([^)]*\bamount\b/);
    expect(code).toMatch(/api\.assignPoints\(\s*customer\.id,\s*earn\.base\b/);
  });

  it('sends the money under `purchase`', () => {
    expect(customerSource).toMatch(/api\.assignPurchasePoints\(\s*customer\.id,\s*amount,/);
  });

  it('never sends the estimate as either mechanic’s input', () => {
    const code = customerCode();

    for (const forbidden of ['earn.preview', 'previewPoints(', 'Math.floor']) {
      const asArgument = code.match(
        new RegExp(`api\\.assign\\w*Points\\([^)]*${forbidden.replace('(', '\\(')}`),
      );
      expect(asArgument?.[0] ?? '', `"${forbidden}" is sent as the base`).not.toContain(forbidden);
    }
  });

  it('labels the field in the mechanic’s own unit', () => {
    // The modal said "Monto de venta ($)" while sending that number as a count, so
    // the operator was told to type pesos and the worker was handed a visit count.
    // Under `visit` the label has to name the count — otherwise a `1` reads as a
    // mistake rather than as one visit.
    const modal = customerModal();

    expect(modal).toMatch(/label htmlFor="sale-amount"/);
    // The label itself comes from the rule's mechanic, not from a fixed string.
    expect(modal).toMatch(/\{[a-zA-Z]*[Ll]abel\}/);
  });

  it('offers a whole-number step under visit', () => {
    // `step="1"` is what stops the operator typing 3.5 into a field the worker
    // requires to be an integer — the same failure, one keystroke away.
    const modal = customerModal();

    expect(modal).toMatch(/id="sale-amount"[\s\S]{0,200}?step=/);
  });
});
