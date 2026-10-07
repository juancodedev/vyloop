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
 * No tenant is on `purchase` yet, which is exactly why this sat: every existing
 * program is `visit`, and under `visit` the old call is a 201.
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
import { earnBase, resolveEarn } from '../lib/loyalty-points';

const posSource = readFileSync(
  new URL('../app/dashboard/loyalty/pos/page.tsx', import.meta.url).pathname,
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
 * Under `visit` the POS's own `amount` argument is the count it sends — that is
 * the behaviour this fix preserves, not a claim that pesos are visits.
 */
function workerBase(earnBy: 'visit' | 'purchase', amount: number, unit: number): number {
  return earnBy === 'purchase' ? amount / unit : amount;
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
  it('is the caller count under visit, and the money over the unit under purchase', () => {
    expect(earnBase({ earnBy: 'visit', earnRate: 1, earnUnitAmount: 1000 }, 3)).toBe(3);
    expect(earnBase({ earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 }, 3000)).toBe(3);
  });

  it('divides by the tenant’s unit, not by a fixed $1.000', () => {
    // The unit is the merchant's own setting; reading a fixed 1000 is how a
    // 3-points-per-$250 program quietly paid as if it were 1 per $1.000.
    expect(earnBase({ earnBy: 'purchase', earnRate: 3, earnUnitAmount: 250 }, 1000)).toBe(4);
    expect(earnBase({ earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 }, 1000)).toBe(1);
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
    for (const [earnBy, amount, unit] of [
      ['visit', 7, 1000],
      ['purchase', 12500, 1000],
      ['purchase', 1000, 250],
    ] as const) {
      expect(earnBase({ earnBy, earnRate: 2, earnUnitAmount: unit }, amount)).toBe(
        workerBase(earnBy, amount, unit),
      );
    }
  });
});

// ─── 2. The field the mechanic consumes ────────────────────────────────

describe('the body field the program consumes', () => {
  it('is `amount_pesos` for a purchase program', () => {
    expect(
      resolveEarn({ earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 }, 4000, 1).inputField,
    ).toBe('amount_pesos');
  });

  it('is `points` for a visit program', () => {
    // The default mechanic. A change here is a change to every existing tenant.
    expect(
      resolveEarn({ earnBy: 'visit', earnRate: 1, earnUnitAmount: 1000 }, 4000, 1).inputField,
    ).toBe('points');
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
      resolveEarn({ earnBy: 'purchase', earnRate: 3, earnUnitAmount: 250 }, 1000, 2).preview,
    ).toBe(24);
  });

  it('is what the worker will credit, when the tier has not moved', () => {
    for (const [earnBy, amount, unit, rate, tier] of [
      ['visit', 7, 1000, 1, 1],
      ['visit', 1000, 1000, 1.5, 2],
      ['purchase', 12500, 1000, 1, 1],
      ['purchase', 1000, 250, 3, 1.5],
      ['purchase', 1999, 1000, 1, 1],
    ] as const) {
      const resolved = resolveEarn({ earnBy, earnRate: rate, earnUnitAmount: unit }, amount, tier);

      expect(resolved.preview).toBe(
        workerEffectivePoints(workerBase(earnBy, amount, unit), rate, tier),
      );
    }
  });

  it('floors, like the ledger row it estimates', () => {
    // $1.999 at 1 point per $1.000 is 1 unit and a bit; the ledger stores 1.
    expect(
      resolveEarn({ earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 }, 1999, 1).preview,
    ).toBe(1);
  });

  it('does not apply the tier twice', () => {
    const resolved = resolveEarn(
      { earnBy: 'purchase', earnRate: 2, earnUnitAmount: 1000 },
      5000,
      2,
    );

    expect(resolved.preview).toBe(20);
    expect(resolved.preview).not.toBe(workerEffectivePoints(resolved.preview, 2, 2));
  });

  it('leaves the visit estimate exactly where it was', () => {
    // `previewPoints(subtotal, rate, tier)` — unchanged, because every existing
    // tenant is on `visit` and a "fix" that moved this number would move every
    // balance in the ledger.
    const resolved = resolveEarn({ earnBy: 'visit', earnRate: 1.5, earnUnitAmount: 1000 }, 1000, 2);

    expect(resolved.preview).toBe(3000);
    expect(resolved.base).toBe(1000);
  });
});

// ─── 4. Unusable config cannot produce a number nobody can check ───────

describe('an unusable program setting', () => {
  it('falls back to the worker’s own default unit rather than dividing by zero', () => {
    for (const unit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const resolved = resolveEarn(
        { earnBy: 'purchase', earnRate: 1, earnUnitAmount: unit },
        2000,
        1,
      );

      expect(Number.isFinite(resolved.base), `unit ${unit}`).toBe(true);
      // 2000 / 1000 — the same default `formatUnitAmount` describes on the config
      // screen, so the sentence and the estimate never disagree.
      expect(resolved.preview).toBe(2);
    }
  });

  it('falls back to a rate of 1 rather than crediting a NaN estimate', () => {
    for (const rate of [0, -3, Number.NaN]) {
      const resolved = resolveEarn(
        { earnBy: 'purchase', earnRate: rate, earnUnitAmount: 1000 },
        1000,
        1,
      );

      expect(Number.isFinite(resolved.preview), `rate ${rate}`).toBe(true);
    }
  });

  it('is not negative for an empty or refunded cart', () => {
    // Nothing was bought, so nothing is owed. A negative estimate on screen is
    // how a cashier starts apologising for a sale that has not happened.
    for (const amount of [0, -500]) {
      const resolved = resolveEarn(
        { earnBy: 'purchase', earnRate: 1, earnUnitAmount: 1000 },
        amount,
        1,
      );

      expect(resolved.preview).toBeLessThanOrEqual(0);
    }
  });
});

// ─── 5. The request the worker will actually accept ────────────────────

describe('the sale as the worker will read it', () => {
  /** What the POS does for a sale: pick the method, send the subtotal. */
  async function chargeLikeThePos(
    rule: { earnBy: 'visit' | 'purchase'; earnRate: number; earnUnitAmount: number },
    subtotal: number,
  ): Promise<{ earnBy: 'visit' | 'purchase'; body: Record<string, unknown> }> {
    // One sale per call, so `lastAssignBody`'s single-request assertion means what
    // it says: this sale produced exactly one request.
    sent = [];
    respondWith(ASSIGN_OK);
    const resolved = resolveEarn(rule, subtotal, 1);

    if (resolved.inputField === 'amount_pesos') {
      await api.assignPurchasePoints('cust-1', subtotal, 'Venta POS: Latte x1');
    } else {
      await api.assignPoints('cust-1', subtotal, 'Venta POS: Latte x1');
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

  it('KNOWN GAP — is refused for a fractional sale under a visit program', async () => {
    // Not this work unit's contract, and not something it may quietly "fix": the
    // caller sends a peso subtotal as `points`, and the worker requires that count
    // to be an integer. So a $3.50 sale is refused with `VALIDATION_ERROR`, while
    // a $4.00 one is accepted.
    //
    // Both halves are true at once: `551b912` is correct to require a count, and
    // the POS is wrong to send money as one — the worker's own comment says the
    // honest fact at a counter is "a visit happened", not "the customer spent
    // $4.500". Correcting it means changing what `visit` credits for every existing
    // tenant, which is a separate decision and a separate work unit.
    //
    // Pinned so the gap stays visible: if this flips to `true`, the worker changed,
    // and whoever owns that decision needs to re-check this expectation.
    const sale = await chargeLikeThePos(
      { earnBy: 'visit', earnRate: 1, earnUnitAmount: 1000 },
      3.5,
    );

    expect(workerAccepts(sale.earnBy, sale.body)).toBe(false);
    expect(sale.body.points).toBe(3.5);
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

  it('sends the raw subtotal under both mechanics', () => {
    // Same value, different field: which field is the program's fact, what the
    // sale is worth is the cashier's.
    expect(posSource).toMatch(/api\.assignPurchasePoints\(\s*customer\.id,\s*subtotal,/);
    expect(posSource).toMatch(/api\.assignPoints\(\s*customer\.id,\s*subtotal,/);
  });

  it('never sends the estimate as either mechanic’s input', () => {
    // The defect `loyalty-points.contract.test.ts` already pins for `visit`,
    // re-asserted for the method that did not exist when it was written.
    //
    // Read without the comments: this page's own commentary names the old call it
    // replaced, and a test that greps prose fails the next time somebody explains
    // the bug accurately in a comment.
    const code = posCode();

    expect(code).not.toMatch(/previewPoints\(/);
    for (const forbidden of ['earn.preview', 'earn.base', 'earnBase(', 'previewPoints(']) {
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
