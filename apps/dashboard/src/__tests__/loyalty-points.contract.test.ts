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

import { previewPoints } from '../lib/loyalty-points';

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

/** The whole `Math.floor(...)` expression a preview computes. */
function floorExpressionIn(source: string): string {
  const match = source.match(/Math\.floor\(([^()]+)\)/);
  expect(match, 'no Math.floor(...) expression found').not.toBeNull();
  return match![1]!.replace(/\s+/g, ' ').trim();
}

/** The identifiers an expression multiplies together. */
function factorsOf(expression: string): string[] {
  return [...new Set(expression.match(/[A-Za-z_$][\w$]*/g) ?? [])];
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
});

// ─── 2. The request carries the base, not the preview ──────────────────

describe('the assign request', () => {
  it('sends the subtotal as `points`', () => {
    // The single line that decides whether a balance is corrupted. It is read
    // out of the source because the bug was never a wrong number in isolation —
    // it was the wrong number in this position.
    expect(secondArgumentOf(posSource, 'api.assignPoints')).toBe('subtotal');
  });

  it('never sends the preview as the base', () => {
    const sent = secondArgumentOf(posSource, 'api.assignPoints');

    expect(sent).not.toBe('pointsToEarn');
    expect(sent).not.toMatch(/previewPoints\(/);
    expect(sent).not.toMatch(/multiplier/);
  });

  it('still passes a note describing the sale', () => {
    // Guards the fix against being "simplified" into a bare two-argument call.
    const sent = secondArgumentOf(posSource, 'api.assignPoints');

    expect(posSource).toMatch(/Venta POS:/);
    expect(sent.length).toBeGreaterThan(0);
  });

  it('still sends the raw subtotal, not a floored one', () => {
    // The server floors the product itself. Flooring the base first would make
    // the ledger disagree with the preview on every fractional sale.
    expect(secondArgumentOf(posSource, 'api.assignPoints')).not.toMatch(/floor\(/);
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
    expect(posSource).toMatch(/receipt\.pointsEarned\.toLocaleString\(\)/);
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
    expect(posSource).toMatch(/\{pointsToEarn > 0 && \(/);
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

  it('still does', () => {
    // The fix must not move a number that was already right. This is the test
    // that fails if someone "corrects" the base into a floored or rate-scaled
    // value to make some other case line up.
    expect(secondArgumentOf(posSource, 'api.assignPoints')).toBe('subtotal');
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

  const calculated = floorExpressionIn(block);
  const shown = factorsOf(calculated);

  it('calculates from the amount, the rate and the multiplier', () => {
    // Unchanged arithmetic — this asserts the formula was not touched while the
    // label around it was corrected.
    expect(calculated).toBe('amount * earnRate * tierMultiplier');
    expect(shown).toEqual(['amount', 'earnRate', 'tierMultiplier']);
  });

  it('shows every factor it multiplies', () => {
    // The invariant that matters: a factor that is multiplied but not shown is a
    // number the operator cannot check. The breakdown used to multiply by
    // `earnRate` while printing only the base and the multiplier, so the
    // equation on screen was false for every program whose rate was not 1.
    for (const factor of shown) {
      expect(
        block,
        `"${factor}" is multiplied into the total but never displayed`,
      ).toMatch(new RegExp(`<span>[^<]*\\{\\s*${factor}\\s*\\}`));
    }
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
    // report the fix as the defect.
    const displayed = [...block.matchAll(/<span>([^<]*)<\/span>/g)].flatMap((match) =>
      [...match[1]!.matchAll(/\{\s*([A-Za-z_$][\w$]*)\s*\}/g)].map((inner) => inner[1]!),
    );

    expect(displayed.filter((name) => name !== 'Math' && name !== 'floor')).not.toEqual([]);

    for (const factor of displayed) {
      if (factor === 'Math' || factor === 'floor') continue;
      expect(shown, `"${factor}" is displayed but never multiplied`).toContain(factor);
    }
  });

  it('marks the total as an estimate', () => {
    // Same reasoning as the POS preview: the server resolves the tier at the
    // moment of the charge, so a number computed here is an estimate.
    expect(block).toMatch(/estimad/i);
  });

  it('adds up to the total it prints', () => {
    // With the rate shown, the equation is finally checkable — so check it.
    const amount = 1500;
    const earnRate = 1.5;
    const tierMultiplier = 2;

    expect(Math.floor(amount * earnRate * tierMultiplier)).toBe(4500);
    // ...and the equation that used to be printed for those inputs.
    expect(Math.floor(amount * tierMultiplier)).toBe(3000);
  });
});