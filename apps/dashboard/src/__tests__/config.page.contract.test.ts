// @vitest-environment node

/**
 * The config screen's money wording has to come from the rule, not sit next to it.
 *
 * ## The defect
 *
 * `apps/dashboard/src/app/dashboard/loyalty/config/page.tsx` rendered:
 *
 *   {config.earnRate} punto por cada $1.000
 *   Por cada $1.000 pesos de compra, el cliente recibe {config.earnRate} punto(s)
 *
 * and nothing in the system converted pesos into points. `earn_rate` was a
 * multiplier on a caller-supplied `points` value, so a merchant reading that screen
 * believed their program paid out on spend while the balance was in fact decided
 * by whichever integration made the call. `lib/loyalty-earn-rule.ts` now builds
 * the sentence from the configured mechanic; this file is what keeps the page from
 * growing a second, hand-written version of it.
 *
 * ## Why the page is read as source
 *
 * `apps/dashboard/vitest.config.ts` sets no `environment`, so the dashboard runs in
 * `node` and nothing renders. `loyalty-points.contract.test.ts` establishes the
 * pattern: assert on the expression the page hands the API, because the bug was
 * never a wrong number in isolation — it was the wrong number in that position.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const configPageSource = readFileSync(
  new URL('../app/dashboard/loyalty/config/page.tsx', import.meta.url).pathname,
  'utf8',
);

/** Text inside a JSX expression, i.e. what a merchant would actually read. */
function renderableText(): string {
  // Strip the import block and the import/export keywords so the scan below is
  // about copy rather than about a type annotation that mentions a symbol.
  return configPageSource
    .replace(/^import[\s\S]*?from\s+'[^']*';$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('the loyalty config page describes the rule it is running', () => {
  it('has no hardcoded money wording of its own', () => {
    // The exact defect: a literal "$1.000" in this file is a promise made by
    // hand, and it cannot move when the merchant's rule changes.
    const text = renderableText();

    expect(text).not.toMatch(/\$\s?1\.000/);
    expect(text).not.toMatch(/punto por cada \$/);
    expect(text).not.toMatch(/pesos de compra/);
  });

  it('builds its description from the rule module', () => {
    // The structural half of the guarantee: the sentence is imported, not typed.
    expect(configPageSource).toMatch(/import\s*\{[^}]*describeEarnRule[^}]*\}\s*from\s*'@\/lib\/loyalty-earn-rule'/);
    expect(configPageSource).toMatch(/describeEarnRule\(/);
  });

  it('renders the mechanic the program actually runs', () => {
    // Both mechanics are offered on the edit form. A page that only ever showed
    // one would be the same false promise in the other direction: a merchant
    // whose program earns by visit could not tell that from a purchase program.
    expect(configPageSource).toMatch(/earnBy/);
    expect(configPageSource).toMatch(/earnUnitAmount/);
    expect(configPageSource).toMatch(/purchase/);
    expect(configPageSource).toMatch(/visit/);
  });

  it('keeps the rate label honest about what the rate is a rate of', () => {
    // The old label read "Tasa de acumulación (puntos por $1.000)", which asserted
    // the money mechanic for a program that had none.
    expect(configPageSource).toMatch(/TASA DE ACUMULACIÓN/);
    expect(configPageSource).not.toMatch(/puntos por \$1\.000/);
  });

  it('tells the merchant that a visit does not depend on the amount', () => {
    // The option hint is the only place a merchant reads, before saving, what one
    // visit is worth. Under `visit` the caller sends a count and the worker refuses
    // a non-integer one, so "does not depend on the amount" is the fact that makes
    // the program make sense — and the absence of it is what made a fractional-peso
    // sale fail with no on-screen explanation.
    //
    // No money in it: the hint for `visit` says so in words, because a peso figure
    // here would describe the mechanic this program does not run.
    const visitHint = configPageSource.match(/value: 'visit',[\s\S]*?hint:\s*'([^']+)'/);

    expect(visitHint, 'no visit option hint found').not.toBeNull();
    expect(visitHint![1]!.toLowerCase()).toMatch(/no depende/i);
    expect(visitHint![1]!).not.toContain('$');
    expect(visitHint![1]!.toLowerCase()).not.toContain('pesos');
  });

  it('names a redeemed sale as one visit, which is what the POS sends', () => {
    // The specific gap: the hint used to say "visita, chequeo o conteo" without ever
    // saying that a sale IS one. A merchant reading it could reasonably think the
    // count came from somewhere else in the system, and the POS sends exactly this
    // — one count per redeemed sale — which is why the sentence has to name it.
    const visitHint = configPageSource.match(/value: 'visit',[\s\S]*?hint:\s*'([^']+)'/);

    expect(visitHint![1]!.toLowerCase()).toMatch(/venta cobrada/);
  });

  it('does not let the visit option describe a spend-based program', () => {
    // The mirror of the assertion above: a `visit` option whose hint promises money
    // would be the same false promise this file was written for, in the one place a
    // merchant chooses between the two mechanics.
    const visitHint = configPageSource.match(/value: 'visit',[\s\S]*?hint:\s*'([^']+)'/);

    expect(visitHint![1]!.toLowerCase()).not.toMatch(/de compra/);
    expect(visitHint![1]!.toLowerCase()).not.toMatch(/pesos/);
  });
});