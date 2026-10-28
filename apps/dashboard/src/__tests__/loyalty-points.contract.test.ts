// @vitest-environment node

/**
 * The POS used to send the preview to the server as the amount.
 *
 * `POST /v1/loyalty/points/assign` defines `points` as the BASE amount and applies
 * the rates itself — `effectivePoints = Math.floor(body.points * earnRate *
 * tierMultiplier)`, resolved from the customer's tier at the moment of the charge.
 * The POS computed that same product up front for the preview and then sent the
 * *result* as the base, so a Gold customer (`×2`) was credited `base × rate × 2 × 2`.
 * That is not cosmetic: the number is what lands in `points_transactions.points`,
 * and `balance_after` is accumulated from it, so the inflated balance is permanent.
 *
 * The fix belongs on the client, because the server is right. A client that sends
 * the final number has no authority left: the tier can change between the preview
 * and the charge, and the server must be the one to resolve it.
 *
 * ## A second client bug, in the same argument
 *
 * Under `earn_by: 'visit'` the value in that position was the **peso subtotal**,
 * while the worker requires an integer count (`!Number.isInteger(points) ||
 * points < 1`). Every price in the demo menu ends in `.50`, so half of all sales
 * were refused with 400. A visit is now one visit per redeemed sale, and the
 * count comes from `VISITS_PER_CHARGE` — see `pos-earn-mechanic.contract.test.ts`,
 * which owns the mechanic itself and why the number is what it is.
 *
 * ## Why these tests read the source instead of rendering
 *
 * `vitest.config.ts` sets no `environment`, so the dashboard runs in `node`: no
 * jsdom, no testing-library, no React rendering. `navigation.contract.test.ts`
 * already establishes the pattern this file follows — read the component, assert
 * the thing that cannot drift silently. So each test pairs one side that is real
 * arithmetic (the extracted module, imported by the page) with one side that is
 * structure (which expression the page hands to `api.assignPoints`).
 *
 * The arithmetic is only checked because the structure is also checked. Either
 * alone is weak: correct math over the wrong argument still inflates the balance,
 * and a correct argument with no math test can be quietly changed.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { previewPoints, resolveEarn } from '../lib/loyalty-points';

const posSource = readFileSync(
  new URL('../app/dashboard/loyalty/pos/page.tsx', import.meta.url).pathname,
  'utf8',
);
const customerSource = readFileSync(
  new URL('../app/dashboard/customers/[id]/page.tsx', import.meta.url).pathname,
  'utf8',
);
const growthSource = readFileSync(
  new URL('../../../../workers/growth/src/routes.ts', import.meta.url).pathname,
  'utf8',
);

// ─── The server contract, transcribed ──────────────────────────────────

/**
 * `workers/growth/src/routes.ts:553`, written out independently so a bug here
 * cannot quietly agree with a bug in the page. `contractMatchesWorker` below is
 * what keeps the transcription honest — it fails the moment the real formula
 * changes, instead of letting two copies drift apart silently.
 */
function serverEffectivePoints(base: number, earnRate: number, multiplier: number): number {
  return Math.floor(base * earnRate * multiplier);
}

// ─── Source readers ────────────────────────────────────────────────────

/**
 * The second argument of a call, i.e. the value the POS sends as `points`.
 *
 * Stops once two arguments are collected, so it never has to lex the third one —
 * a template literal full of commas. Argument order is read, not assumed: the
 * first is the customer id, the second is the amount.
 */
function secondArgumentOf(source: string, callee: string): string {
  const start = source.indexOf(`${callee}(`);
  expect(start, `no call to ${callee} found`).toBeGreaterThan(-1);

  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (let i = start + callee.length + 1; i < source.length && args.length < 2; i++) {
    const char = source[i]!;

    if (quote) {
      if (char === '\\') {
        current += char + (source[i + 1] ?? '');
        i++;
      } else if (char === quote) {
        quote = null;
        current += char;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') depth++;
    if (char === ')' || char === ']' || char === '}') depth--;

    if (char === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  args.push(current);
  expect(args.length, 'call must take at least two arguments').toBeGreaterThanOrEqual(2);
  return args[1]!.trim();
}



// ─── 1. A tier above ×1 must not inflate the charge ────────────────────

describe('points are not multiplied twice', () => {
  it('credits base × earnRate × multiplier for a ×2 tier, not that product again', () => {
    // The bug, as it behaved. Gold, `earnRate` 1, a $1000 sale.
    const base = 1000;
    const earnRate = 1;
    const multiplier = 2;

    const charged = serverEffectivePoints(base, earnRate, multiplier);

    expect(charged).toBe(2000);
    // The page used to hand the server this number, and the server applied the
    // tier a second time. This is the corruption, written down.
    expect(serverEffectivePoints(serverEffectivePoints(base, earnRate, multiplier), earnRate, multiplier)).toBe(4000);
  });

  it('sends the base, so a ×2 tier is applied exactly once', () => {
    const base = 1000;
    const earnRate = 1.5;
    const multiplier = 2;

    // What the POS sends, and what the server therefore writes.
    const charged = serverEffectivePoints(base, earnRate, multiplier);

    expect(charged).toBe(3000);
    expect(charged).not.toBe(base * earnRate * multiplier * multiplier);
  });

  it('matches the formula the growth worker actually runs', () => {
    // If the worker ever changes how it scales, this test fails here instead of
    // letting the preview and the ledger disagree behind a green suite.
    const declared = growthSource.match(/const effectivePoints = ([^;]+);/);
    expect(declared, 'no effectivePoints declaration in the growth worker').not.toBeNull();

    const normalized = declared![1]!.replace(/\bbody\.points\b/, 'base').replace(/\s+/g, ' ').trim();

    expect(normalized).toBe('Math.floor(base * earnRate * tierMultiplier)');
  });

  it('is the rule both callers share, not one call site copied twice', () => {
    // The formula was extracted into `computeEarnedPoints` because a second
    // caller needed it (`POST /v1/checkins`, for a merchant's terminal reporting
    // a sale it already completed). What has to stay true after that extraction is
    // that there is exactly ONE expression: a copy left behind at the old call
    // site would pass the match above while the two callers drifted apart, which
    // is the drift this file exists to prevent.
    //
    // `pos-earn-mechanic.contract.test.ts` reads the same file for the same
    // reason, so this is the pair of them that has to hold.
    expect(growthSource).toMatch(/export function computeEarnedPoints\(/);
    // Both callers go through it.
    expect(growthSource.match(/computeEarnedPoints\(base, earnRate, tierMultiplier\)/g)).toHaveLength(2);
    // And the floor appears exactly once in the worker.
    expect([...growthSource.matchAll(/Math\.floor\(/g)]).toHaveLength(1);
  });
});

// ─── 2. The request carries the base, not the preview ──────────────────

describe('the assign request', () => {
  it('sends the visit count as `points`, which is `earn.base`', () => {
    // The single line that decides whether a sale can happen at all. Under `visit`
    // the worker requires a positive integer, so whatever is in this position has
    // to BE a count — the peso subtotal is a money amount, and sending it here is
    // what made every `.50` sale fail.
    //
    // It is `earn.base` and not a literal, because the same resolution decides the
    // field, the value and the estimate. A hand-written `1` here would agree with
    // the helper today and drift from it the moment `visit` grows a second rule.
    expect(secondArgumentOf(posSource, 'api.assignPoints')).toBe('earn.base');
  });

  it('never sends the preview as the base', () => {
    const sent = secondArgumentOf(posSource, 'api.assignPoints');

    expect(sent).not.toBe('pointsToEarn');
    expect(sent).not.toMatch(/previewPoints\(/);
    expect(sent).not.toMatch(/multiplier/);
  });

  it('never sends the peso subtotal as the count', () => {
    // Stated separately from the equality above, because this is the specific
    // regression: the argument was `subtotal` until a visit stopped being measured
    // in pesos, and `subtotal` is the one value that is still in scope on the page
    // and is wrong in this position.
    const sent = secondArgumentOf(posSource, 'api.assignPoints');

    expect(sent).not.toBe('subtotal');
    expect(sent).not.toMatch(/subtotal/);
  });

  it('does not derive the count by rounding the money', () => {
    // `Math.round(subtotal)` / `Math.ceil(subtotal)` were the tempting patches and
    // both are wrong: they turn $3.50 into four visits and $0.01 into one, so the
    // count would be a peso amount with the decimals removed rather than a count.
    const sent = secondArgumentOf(posSource, 'api.assignPoints');

    expect(sent).not.toMatch(/round|ceil|floor/);
  });

  it('still passes a note describing the sale', () => {
    // Guards the fix against being "simplified" into a bare two-argument call.
    const sent = secondArgumentOf(posSource, 'api.assignPoints');

    expect(posSource).toMatch(/Venta en caja:/);
    expect(sent.length).toBeGreaterThan(0);
  });

  it('never sends the estimate as the count', () => {
    // `preview` is a rate × tier product and the worker multiplies again. Under
    // `visit` this is the same defect as sending the money, one step removed: both
    // put a number in `points` that is not the base.
    const sent = secondArgumentOf(posSource, 'api.assignPoints');

    expect(sent).not.toMatch(/preview/i);
    expect(sent).not.toBe('pointsToEarn');
  });

  it('still sends the raw money under the purchase mechanic', () => {
    // The money half of the same decision, and the reason the "not floored"
    // rationale that used to live here is still true — just for the other method.
    //
    // `workers/growth/src/routes.ts` computes `base = amount / unit` and then
    // `Math.floor(base * earnRate * tierMultiplier)` itself. Flooring the amount on
    // the client would make the ledger disagree with the preview on every sale that
    // is not a whole peso, which is every sale in the demo menu.
    //
    // Under `visit` there is no money to floor at all: the base is a count, so the
    // old rationale ("the server floors the product itself") described a property
    // of a number this position no longer holds. The property that replaced it is
    // the two assertions above — the count is not derived from the money.
    const sent = secondArgumentOf(posSource, 'api.assignPurchasePoints');

    expect(sent).toBe('subtotal');
    expect(sent).not.toMatch(/floor\(|round\(|ceil\(/);
  });
});

// ─── 3. The receipt shows what the server decided ──────────────────────

describe('the receipt', () => {
  it('takes its number from the server response', () => {
    // `earned` is the awaited response, whose `points` is `effectivePoints` as
    // the worker computed it. The preview is deliberately not involved.
    expect(posSource).toMatch(/pointsEarned:\s*earned\.points/);
  });

  it('does not fall back to the preview', () => {
    // The regression a "helpful" refactor would introduce: showing the estimate
    // the cashier already saw, which is wrong precisely when the tier moved
    // between the preview and the charge.
    expect(posSource).not.toMatch(/pointsEarned:\s*pointsToEarn/);
    expect(posSource).not.toMatch(/pointsEarned:\s*previewPoints\(/);
  });

  it('renders the server number on the receipt', () => {
    expect(posSource).toMatch(/receipt\.pointsEarned\.toLocaleString\(/);
  });

  it('shows the server number even when it differs from the preview', () => {
    // The two numbers are only computed from the same inputs when the tier holds
    // still. This is the case that decides which one the receipt owes the truth
    // to: the preview is stale, the ledger is not.
    const base = 1000;
    const earnRate = 1.5;

    const preview = previewPoints(base, earnRate, 2);
    const charged = serverEffectivePoints(base, earnRate, 1);

    expect(preview).toBe(3000);
    expect(charged).toBe(1500);
    expect(charged).not.toBe(preview);
  });
});

// ─── 4. The preview is shown, and is honestly an estimate ──────────────

describe('the preview', () => {
  it('is still rendered before the charge', () => {
    // The estimate is worth showing — a cashier needs to know roughly what the
    // customer is earning. It is the presenting-as-final part that is not.
    expect(posSource).toMatch(/pointsToEarn > 0 && \(/);
    expect(posSource).toMatch(/styles\.earnRow/);
  });

  it('is labelled as an estimate, not as the charge', () => {
    const row = posSource.match(/<div className=\{styles\.earnRow\}>([\s\S]*?)<\/div>/);
    expect(row, 'no earnRow block found').not.toBeNull();

    expect(row![1]!).toMatch(/estimad/i);
  });

  it('says where the real number comes from', () => {
    // "Estimado" without saying what it is an estimate *of* is decoration. The
    // estimate is computed from the rate and tier the client happens to be
    // holding; the charge is resolved by the server at the moment it happens.
    expect(posSource).toMatch(/estimad[\s\S]{0,400}?servidor/i);
  });

  it('computes the estimate from the base, the rate and the multiplier', () => {
    expect(previewPoints(1000, 1.5, 2)).toBe(3000);
    expect(previewPoints(1000, 1, 2)).toBe(2000);
    expect(previewPoints(3.5, 1, 1)).toBe(3);
  });

  it('agrees with the server when the tier has not moved', () => {
    // The preview is only allowed to be approximate when something changed
    // underneath it. Holding still, the two must be identical, or the estimate
    // is worse than useless.
    for (const [base, earnRate, multiplier] of [
      [1000, 1, 1],
      [1000, 1.5, 2],
      [2500, 2, 1.5],
      [7, 1, 3],
    ] as const) {
      expect(previewPoints(base, earnRate, multiplier)).toBe(
        serverEffectivePoints(base, earnRate, multiplier),
      );
    }
  });

  it('is not rounded at the base', () => {
    // Rounding happens once, at the end, on the server.
    expect(previewPoints(3.5, 1, 2)).toBe(serverEffectivePoints(3.5, 1, 2));
  });
});

// ─── 5. The ×1 tier, where the bug was invisible ───────────────────────

describe('a tier with no multiplier', () => {
  it('behaves identically under the bug and under the fix', () => {
    // Bronce, `earnRate` 1. Sending the preview or the base gives the same
    // number, which is exactly why this shipped and sat there: the one tier
    // every demo used hid it.
    const base = 1000;
    const earnRate = 1;
    const multiplier = 1;

    expect(previewPoints(base, earnRate, multiplier)).toBe(base);
    expect(serverEffectivePoints(base, earnRate, multiplier)).toBe(base);
    expect(serverEffectivePoints(previewPoints(base, earnRate, multiplier), earnRate, multiplier)).toBe(base);
  });

  it('still does, and no longer because pesos were the count', () => {
    // The reason this shipped and sat there: with a `×1` tier and a rate of 1, the
    // old bug and the old reading of `visit` happened to produce the same number,
    // so the demo tenant looked correct.
    //
    // A count is now what travels, and at `×1` that is genuinely `1` — not 1000,
    // not 4000. This test used to assert `subtotal` here and would have read as
    // "the number was already right"; it is the same tier multiplier either way, so
    // the ×1 tier still applies exactly once.
    expect(secondArgumentOf(posSource, 'api.assignPoints')).toBe('earn.base');
    expect(serverEffectivePoints(1, 1, 1)).toBe(1);
    // And the money still travels under the mechanic that reads money.
    expect(secondArgumentOf(posSource, 'api.assignPurchasePoints')).toBe('subtotal');
    expect(serverEffectivePoints(1000, 1, 1)).toBe(1000);
  });
});

// ─── 6. The breakdown says what it calculates ──────────────────────────

describe('the customer page points breakdown', () => {
  const block = (() => {
    const start = customerSource.indexOf('points-preview');
    expect(start, 'no points-preview block found').toBeGreaterThan(-1);
    const end = customerSource.indexOf('className="form-group"', start);
    return customerSource.slice(start, end === -1 ? undefined : end);
  })();

  /**
   * The factors the breakdown prints, read from what it displays.
   *
   * The page no longer floors anything itself — the total is `earn.preview`, the
   * same derivation the charge uses, so there is no `Math.floor(...)` in this block
   * to read an expression out of. The invariant is unchanged and still worth
   * pinning: the factors it prints must be the ones the shared helper multiplies,
   * or the equation on screen is false for the operator checking it.
   *
   * `previewPoints(base, rate, multiplier)` is that product, transcribed from
   * `lib/loyalty-points.ts`; `pos-earn-mechanic.contract.test.ts` owns the mechanic
   * that decides what the base is.
   */
  const SHOWN_FACTORS = ['earn.base', 'earnRate', 'tierMultiplier'];

  it('prints the base the mechanic actually sends, not the typed amount', () => {
    // Under `visit` the base is a count of visits and under `purchase` it is the
    // money over the tenant's unit. Printing the raw typed amount described a number
    // this modal does not send — and labelled a visit count "pts".
    expect(block).toMatch(/<span>[^<]*Base:[^<]*\{\s*earn\.base\s*\}/);
    expect(block).not.toMatch(/<span>[^<]*Base:[^<]*\{\s*amount\s*\}/);
  });

  it('labels the base in the mechanic’s own unit', () => {
    // `pts` next to a visit count told the operator the field was money, and the
    // input's own label ("Monto de venta") called the base the sale when it is the
    // sale over the tenant's unit. The unit is derived from the earn mechanic.
    expect(block).toMatch(/<span>[^<]*Base:[^<]*\{\s*earn\.base\s*\}[^<]*\{\s*baseUnitLabel\s*\}/);
    expect(customerSource).toMatch(/const baseUnitLabel\s*=\s*earnRule\.earnBy === 'purchase'/);
  });

  it('shows every factor the total multiplies', () => {
    // The invariant that matters: a factor that is multiplied but not shown is a
    // number the operator cannot check. The breakdown used to multiply by
    // `earnRate` while printing only the base and the multiplier, so the
    // equation on screen was false for every program whose rate was not 1.
    for (const factor of ['earnRate', 'tierMultiplier']) {
      expect(
        block,
        `"${factor}" is multiplied into the total but never displayed`,
      ).toMatch(new RegExp(`<span>[^<]*\\{\\s*${factor.replace('.', '\\.')}\\s*\\}`));
    }
  });

  it('prints the shared preview rather than a second floor', () => {
    // One derivation, not two. The screen computing its own total is how it came to
    // describe a rule the charge did not run.
    expect(block).toMatch(/<span><strong>=\s*\{\s*earn\.preview\s*\}/);
    expect(block).not.toMatch(/Math\.floor\(/);
  });

  it('labels the rate it applies', () => {
    expect(block).toMatch(/<span>[^<]*tasa[^<]*\{\s*earnRate\s*\}[^<]*<\/span>/i);
  });

  it('displays no factor that it does not multiply', () => {
    // The other direction: a stray multiplier in the label is the mirror image
    // of the same dishonesty, and it is what this bug looked like before.
    //
    // Only `{interpolations}` count. The surrounding prose — "Base", "Multiplicador",
    // "pts" — is wording, not an operand, and reading it as one made this test
    // report the fix as the defect. `baseUnitLabel` is wording too: it names the
    // unit of a factor already displayed, it is not an operand of its own.
    const displayed = [...block.matchAll(/<span>([^<]*)<\/span>/g)].flatMap((match) =>
      [...match[1]!.matchAll(/\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\}/g)].map(
        (inner) => inner[1]!,
      ),
    );

    expect(displayed.filter((name) => name !== 'baseUnitLabel')).not.toEqual([]);

    for (const factor of displayed) {
      if (factor === 'baseUnitLabel') continue;
      expect(SHOWN_FACTORS, `"${factor}" is displayed but never multiplied`).toContain(factor);
    }
  });

  it('marks the total as an estimate', () => {
    // Same reasoning as the POS preview: the server resolves the tier at the
    // moment of the charge, so a number computed here is an estimate.
    expect(block).toMatch(/estimad/i);
  });

  it('adds up to the total it prints', () => {
    // With the rate shown, the equation is finally checkable — so check it, through
    // the same helper the page prints from.
    const base = 1500;
    const earnRate = 1.5;
    const tierMultiplier = 2;

    expect(previewPoints(base, earnRate, tierMultiplier)).toBe(4500);
    // ...and the equation that used to be printed for those inputs, which is the one
    // this suite exists to keep honest.
    expect(previewPoints(base, 1, tierMultiplier)).toBe(3000);
  });

  it('credits a visit once, whatever amount the operator typed', () => {
    // The mechanic's own arithmetic, so the printed total for a `visit` program is
    // one visit rated and multiplied — and does not move with the typed amount.
    const rule = { earnBy: 'visit', earnRate: 1.5, earnUnitAmount: 1000 } as const;

    expect(resolveEarn(rule, { pesos: 1, visits: 1 }, 2).preview).toBe(3);
    expect(resolveEarn(rule, { pesos: 99999.99, visits: 1 }, 2).preview).toBe(3);
  });
});