// @vitest-environment node

/**
 * Claims the public programme page must never make.
 *
 * This page exists to be read during Google's publishing approval, so anything
 * it asserts can be checked against the product. That makes it a liability
 * rather than marketing copy: a sentence that is not true yet is the kind of
 * thing a reviewer can verify, and being wrong there costs the approval.
 *
 * The customer app's own delivery gate covers `app/`. This page lives in
 * `public/`, which that gate does not read, so it needs its own. Kept as a test
 * rather than a review note because these claims regress silently — someone
 * makes a pass "live" in a hurry, or pastes a number in that is not measured.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const pagePath = new URL('../public/program.html', import.meta.url).pathname;
const page = readFileSync(pagePath, 'utf8');

/**
 * The text a reader sees, with markup, comments, scripts and styles removed and
 * whitespace collapsed.
 *
 * Collapsing whitespace matters: a sentence wrapped across source lines would
 * otherwise read as two fragments, and a guard looking for a phrase would miss a
 * claim that is actually on the page. `String.match` returns null rather than an
 * empty array when nothing matches, so every result goes through `?? []` —
 * asserting `toEqual([])` against null fails for a page that is clean.
 */
const visible = page
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ');

describe('public programme page', () => {
  it('never claims the pass is live for the public', () => {
    // The class is in draft. A page that says customers can already save a pass
    // is describing a product that does not exist, and a reviewer will try it.
    const overclaims = visible.match(
      /\b(?:now\s+available|already\s+(?:available|live)|is\s+live|save\s+(?:it\s+)?(?:now|today)|start\s+saving)\b/gi,
    ) ?? [];
    expect(overclaims).toEqual([]);
  });

  it('never promises a saved pass reaches a customer device before approval', () => {
    // Google only permits passes against an approved class. Until then they reach
    // the issuer's own test accounts only.
    expect(visible).not.toMatch(/customers?\s+can\s+now\s+(?:save|add)/i);
  });

  it('carries no unmeasured numbers', () => {
    // Merchant counts, customer counts and adoption figures are exactly the kind
    // of thing that is true in a pitch and false in a database.
    const numbers = visible.match(
      /\b\d[\d.,]*\s*\+?\s*(?:clientes|socios|comercios|negocios|usuarios|customers|merchants|shops|businesses|users)\b/gi,
    ) ?? [];
    expect(numbers).toEqual([]);
  });

  it('carries no social proof or ratings', () => {
    expect(visible).not.toMatch(/\b\d[\d.,]*\s*\+?\s*(?:estrellas|stars|reviews|reseñas)\b/i);
    expect(visible).not.toMatch(/\btestimon|\breview by|cliente feliz/i);
  });

  it('states the loyalty-only nature explicitly', () => {
    // This is the point of the page for a payments-adjacent reviewer. Getting it
    // from a customer count or a slogan would be worse than not saying it.
    expect(visible).toMatch(/no payment instrument/i);
    expect(visible).toMatch(/no financial account/i);
    expect(visible).toMatch(/no purchase/i);
  });

  it('states that the ledger is the system of record', () => {
    expect(visible).toMatch(/system of record/i);
  });

  it('states the current draft status and the issuer account', () => {
    // A reviewer cross-references this. Being silent about the draft status is
    // the same as implying it is approved.
    expect(visible).toMatch(/draft/i);
    expect(visible).toMatch(/pending this publishing approval/i);
    expect(visible).toMatch(/3388000000023206930/);
  });

  it('labels the pass illustration as a mockup', () => {
    // The card is a rendering, not a real pass. Passing it off otherwise is the
    // kind of claim this file exists to prevent.
    expect(visible).toMatch(/mockup/i);
  });

  it('offers both languages', () => {
    expect(page).toMatch(/data-lang="en"/);
    expect(page).toMatch(/data-lang="es"/);
  });

  it('renders without external requests', () => {
    // A reviewer may open this on a phone with a cold cache, or months from now.
    // A CDN font or a remote image is a page that can come back broken at the
    // moment it is being relied on.
    const remote = page.match(/(?:src|href)\s*=\s*["']https?:\/\//gi) ?? [];
    expect(remote).toEqual([]);
  });

  it('sets the language in the markup rather than assuming English', () => {
    // The language switch is a script, and a script is exactly what a reviewer's
    // reader or a crawler may not run. `lang` has to be in the markup.
    expect(page).toMatch(/<html lang="en"/);
    expect(page).toMatch(/name="viewport"/);
  });

  it('shows content with scripting unavailable', () => {
    // This page exists to be read by Google's publishing review, and every
    // section is inside a `[data-lang]` element, which the stylesheet hides. The
    // only rule that reveals it is `html[data-lang="en"] [data-lang="en"]`, so
    // without `data-lang` in the markup the document renders empty — which a
    // crawler or a text-only reader sees as a product with nothing on it.
    //
    // It shipped that way once: the attribute was added by the script instead of
    // the markup, and the deployed page was blank.
    expect(page).toMatch(/<html[^>]*\sdata-lang="en"/);

    // And the rule that would hide the content must still be the only thing
    // standing between the markup and a blank page, so this stays a real
    // assertion rather than a comment: if both the attribute and the hiding rule
    // are present, the page's visibility is decided by the markup alone.
    expect(visible.length).toBeGreaterThan(0);
    expect(/\[data-lang\]:not\(html\)\s*\{\s*display:\s*none/.test(page)).toBe(true);
  });

  it('does not hide the document root with its own hiding rule', () => {
    // The root carries `data-lang` so the reveal selector can key on it, and the
    // reveal rule is `html[data-lang] [data-lang]` — a descendant combinator, which
    // by definition cannot match `html` itself. So a bare `[data-lang] { display:
    // none }` matches the root, nothing ever reveals it, and the entire document
    // collapses to zero height while every descendant still reports its own
    // `display`. That is the bug this page shipped with, twice.
    const hideRules = [...page.matchAll(/\[data-lang\][^{]*\{[^}]*display:\s*none/g)].map(
      (match) => match[0],
    );
    expect(hideRules.length).toBeGreaterThan(0);
    for (const rule of hideRules) {
      expect(rule).toContain(':not(html)');
    }
  });

  it('reveals the root only through a descendant selector, never directly', () => {
    // If a rule ever targets the root itself it has to also carry the root's
    // display; the safe arrangement is the one above, where the root is never
    // hidden in the first place.
    expect(page).toMatch(/html\[data-lang="en"\]\s+\[data-lang="en"\]/);
    expect(page).not.toMatch(/^\s*\[data-lang="en"\]\s*\{[^}]*display/m);
  });

  it('does not rely on the script to decide the initial language', () => {
    // Belt and braces against the same regression: the script may read a
    // language for the initial state, but it must not be the only thing that
    // sets the attribute the stylesheet keys on.
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '';
    const initial = /setAttribute\(\s*'data-lang'\s*,\s*'en'\s*\)/.test(script);
    expect(initial).toBe(false);
  });
});
