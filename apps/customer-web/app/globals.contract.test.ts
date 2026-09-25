// @vitest-environment node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
const appDir = new URL('./', import.meta.url).pathname;

/** This file, so the guard's own literals are never mistaken for applied classes. */
const SELF = 'globals.contract.test.ts';

/** Every `.ts`/`.tsx` under `app/`, so the check follows new components automatically. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(path);

    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** Class names only — comparison operands are values being tested, not classes. */
function classLiteralsIn(expression: string): string[] {
  // `filter === 'all' ? ' filter-tab--active' : ''` contributes the modifier,
  // not `'all'`. Blank the right-hand side of any comparison before reading the
  // remaining literals, so filter keys and status values stay out of the set.
  const withoutComparisons = expression.replace(
    /[\w$.)\]]\s*(?:===|!==|==|!=|<=|>=|<|>)\s*(?:'[^']*'|"[^"]*"|`[^`]*`)/g,
    (match) => match.replace(/(?:'[^']*'|"[^"]*"|`[^`]*`)$/, ''),
  );

  return literalsIn(withoutComparisons);
}

/**
 * Class-name tokens in one literal's text.
 *
 * `${…}` is *not* discarded wholesale. Assembling a modifier class with a ternary
 * is idiomatic in this codebase:
 *
 *   `reward-card__stock ${reward.stock === 0 ? 'reward-card__stock--empty' : 'reward-card__stock--ok'}`
 *   `movement__points ${mov.points > 0 ? 'movement__points--earned' : 'movement__points--redeemed'}`
 *
 * Dropping the whole interpolation loses those six names, and the guard then
 * cannot notice if their rules are deleted — a live selector silently loses its
 * styling while the suite stays green. So the text before `${` is kept (which is
 * how `club-status--${variant}` yields the prefix `club-status--`) and the
 * interpolation contributes only the class names its own literals spell out,
 * never its identifiers (`state`, `variant`, `reward.stock` are expressions).
 */
function classTokens(text: string): string[] {
  const parts: string[] = [];
  let buffer = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '$' || text[i + 1] !== '{') {
      buffer += text[i];
      i += 1;
      continue;
    }

    parts.push(buffer);
    buffer = '';

    let depth = 1;
    let quote: string | null = null;
    let expression = '';
    let j = i + 2;

    while (j < text.length) {
      const char = text[j];

      if (quote) {
        if (char === '\\') {
          expression += char + (text[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (char === quote) quote = null;
        expression += char;
        j += 1;
        continue;
      }

      if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }

      expression += char;
      j += 1;
    }

    parts.push(...classLiteralsIn(expression));
    i = j;
  }

  parts.push(buffer);

  return parts
    .flatMap((part) => part.split(/\s+/))
    .map((token) => token.trim())
    .filter((token) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(token));
}

/** A `'…'`, `"…"` or `` `…` `` starting at `from`, with its raw contents. */
function quotedAt(source: string, from: number): { text: string; end: number } | null {
  const quote = source[from];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;

  let literal = '';

  for (let i = from + 1; i < source.length; i += 1) {
    const char = source[i];

    if (char === '\\') {
      literal += source[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (char === quote) return { text: literal, end: i + 1 };
    literal += char;
  }

  return null;
}

/** The text of a `className={…}` expression, brace-balanced, strings respected. */
function classNameExpression(source: string, from: number): { text: string; end: number } | null {
  const start = source.indexOf('{', from);
  if (start === -1) return null;

  let depth = 0;
  let quote: string | null = null;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];

    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}' && (depth -= 1) === 0) return { text: source.slice(start + 1, i), end: i + 1 };
  }

  return null;
}

/** Quoted strings inside a JSX expression, used to follow composed class names. */
function literalsIn(expression: string): string[] {
  const found: string[] = [];

  for (let i = 0; i < expression.length; i += 1) {
    const quoted = quotedAt(expression, i);
    if (!quoted) continue;
    found.push(quoted.text);
    i = quoted.end - 1;
  }

  return found.filter(Boolean);
}

/**
 * Classes the pages can actually put on a DOM element.
 *
 * Three shapes, because a `club-*`-only scan of literal values missed the rest:
 *
 *  1. Literal values — `className="card"`, `className={'btn btn--primary'}` and
 *     template literals, including the classes their ternaries select. This is
 *     the historical extraction, now unfiltered by prefix so it covers *every*
 *     class, not just `club-*`.
 *  2. Composed values — `className={expr}` where `expr` is not a plain literal.
 *     Two real sites exist: `ClubShell` builds `` `club-shell ${className}` `` in
 *     a local `const` before applying it, and `FormField` picks between
 *     `` `input ${className}` `` and `'input'`. Neither `.club-shell` nor
 *     `.input` is visible to a literal-only scan, so deleting their rules would
 *     have gone unnoticed. The literals are read out of the expression, or out of
 *     the local `const` a bare identifier refers to — derived from the source,
 *     not a hand-maintained list of names.
 */
function classesInUse(): Set<string> {
  const used = new Set<string>();

  for (const file of sourceFiles(appDir)) {
    if (file.endsWith(SELF)) continue;

    const source = readFileSync(file, 'utf8');
    const add = (text: string) => classTokens(text).forEach((name) => used.add(name));

    for (const match of source.matchAll(/className=/g)) {
      let cursor = match.index + match[0].length;
      while (source[cursor] === ' ') cursor += 1;

      // Shape 1a: className="…" / className='…' / className=`…`
      if (source[cursor] !== '{') {
        const quoted = quotedAt(source, cursor);
        if (quoted) add(quoted.text);
        continue;
      }

      const expression = classNameExpression(source, cursor);
      if (expression === null) continue;

      const trimmed = expression.text.trim();

      // Shape 1b: className={`…`} / className={'…'} — one literal after all.
      const whole = quotedAt(trimmed, 0);
      if (whole && whole.end === trimmed.length) {
        add(whole.text);
        continue;
      }

      // Shape 2: composed.
      classLiteralsIn(expression.text).forEach(add);

      // A bare identifier (`className={shellClassName}`) hides its classes one
      // declaration away; look there too.
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed)) continue;

      const declaration = new RegExp(`(?:const|let|var)\\s+${trimmed}\\b[\\s\\S]{0,400}?;`).exec(source);
      if (declaration) classLiteralsIn(declaration[0]).forEach(add);
    }
  }

  return used;
}

/**
 * Classes the app applies that deliberately have no rule of their own.
 *
 * There is exactly one. `app/not-found.tsx` puts it on `<main>`, and nothing in
 * `globals.css` targets it: the club-barrio redesign gave the 404 page no
 * component class, so it renders on the `body` rules alone — `.customer-web`
 * supplies the palette and the font. It is a hook waiting for a design pass, not
 * a rule that went missing.
 *
 * This is one entry with a stated reason, not a name list to grow quietly, and
 * the test below pins it by exact equality: giving `not-found` a real rule, or
 * applying some other class without one, turns the suite red so the exemption
 * has to be re-argued instead of widening by accident.
 */
const UNSTYLED_BY_DESIGN = ['not-found'];

describe('Stage 0 club-barrio CSS contract', () => {
  it('defines the approved semantic tokens', () => {
    expect(css).toMatch(/--club-ink:\s*#27201d/);
    expect(css).toMatch(/--club-ink-soft:\s*#6f625b/);
    expect(css).toMatch(/--club-paper:\s*#f3eee5/);
    expect(css).toMatch(/--club-surface:\s*#fffdf7/);
    expect(css).toMatch(/--club-cherry:\s*#a9362b/);
    expect(css).toMatch(/--club-cherry-dark:\s*#74231d/);
    expect(css).toMatch(/--club-gold:\s*#c38a35/);
    expect(css).toMatch(/--club-focus:\s*#1e67b1/);
    expect(css).toMatch(/--club-line:\s*rgba\(39, 32, 29, 0\.16\)/);
    expect(css).toMatch(/--club-line-soft:\s*rgba\(39, 32, 29, 0\.09\)/);
    expect(css).toMatch(/--club-radius:\s*18px/);
    expect(css).toMatch(/--club-space-unit:\s*var\(--space-1\)/);
    expect(css).toMatch(/--club-shadow-quiet:/);
    expect(css).toMatch(/--club-transition-fast:\s*var\(--transition-fast\)/);
    expect(css).toMatch(/--club-ease-out:\s*var\(--ease-out\)/);
    expect(css).toMatch(/--club-font-display:\s*var\(--font-body\), system-ui, sans-serif/);
  });

  it('provides focus, reduced motion, and transition safeguards', () => {
    expect(css).toMatch(/:focus-visible\s*\{[\s\S]*?outline:\s*3px solid var\(--club-focus\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).not.toMatch(/transition\s*:\s*all/);
    expect(css).not.toMatch(/outline\s*:\s*none/);
  });
});

describe('stylesheet and markup agree', () => {
  it('has a rule for every class the pages apply', () => {
    const missing = [...classesInUse()]
      .filter((name) => !UNSTYLED_BY_DESIGN.includes(name) && !css.includes(`.${name}`))
      .sort();

    expect(missing).toEqual([]);
  });

  it('exempts only the classes that are unstyled by design', () => {
    // Pins the exemption set: if a rule appears for `not-found`, or another
    // class is applied without one, the list above has to be re-justified.
    const unstyled = [...classesInUse()].filter((name) => !css.includes(`.${name}`)).sort();

    expect(unstyled).toEqual([...UNSTYLED_BY_DESIGN].sort());
  });

  it('finds the classes it is meant to find', () => {
    // Guards the guard: if the extraction above ever stops matching, the test
    // above would pass vacuously on an empty set and stop protecting anything.
    // Asserted across all three shapes the extraction has to handle, including
    // prefixes recovered from template literals and the two composed sites —
    // if any of these regresses the guard goes blind rather than red.
    const used = classesInUse();

    expect(used.size).toBeGreaterThan(100);

    // Literal `club-*` values, from the pages that were redesigned.
    expect(used).toContain('club-login__form');
    expect(used).toContain('club-register__submit');
    expect(used).toContain('club-entry__actions');

    // Non-club legacy classes — the gap that let the old dead CSS hide.
    expect(used).toContain('btn');
    expect(used).toContain('card');
    expect(used).toContain('reward-card__name');
    expect(used).toContain('movement__points');
    expect(used).toContain('confirm-balance__value');
    expect(used).toContain('filter-tabs');

    // Composed `className={…}` sites: only reachable through the local const.
    expect(used).toContain('club-shell');
    expect(used).toContain('input');

    // Prefixes recovered from template literals, not whole names.
    expect(used).toContain('club-status--');
    expect(used).toContain('club-ladder__rung--');

    // Modifiers that only exist as a ternary inside a template literal. These
    // are the regression this extraction was rewritten for: a scan that drops
    // `${…}` wholesale loses all of them, and then deleting their rules keeps
    // the suite green while the UI quietly loses its colour and icons.
    expect(used).toContain('filter-tab--active');
    expect(used).toContain('movement__icon--earned');
    expect(used).toContain('movement__icon--redeemed');
    expect(used).toContain('movement__points--earned');
    expect(used).toContain('movement__points--redeemed');
    expect(used).toContain('reward-card__stock--ok');
    expect(used).toContain('reward-card__stock--empty');
  });
});
