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
 * There are none. It used to be exactly one: `app/not-found.tsx` put
 * `not-found` on its `<main>` with nothing in `globals.css` targeting it, and
 * the test pinned the exemption by exact equality so it could not quietly
 * widen. Stage 6 gave that page a design pass and the exemption went with it.
 *
 * The list stays, and the test below still pins it by exact equality, so the
 * next class applied without a rule has to be re-argued here instead of
 * appearing by accident.
 */
const UNSTYLED_BY_DESIGN: string[] = [];

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
    // Stage 6 added two tones, both measured against the club surfaces rather
    // than chosen by eye. See the contrast floor suite below.
    expect(css).toMatch(/--club-gold-strong:\s*#8a5f1f/);
    expect(css).toMatch(/--club-success:\s*#1c6b45/);
  });

  it('provides focus, reduced motion, and transition safeguards', () => {
    expect(css).toMatch(/:focus-visible\s*\{[\s\S]*?outline:\s*3px solid var\(--club-focus\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).not.toMatch(/transition\s*:\s*all/);
    expect(css).not.toMatch(/outline\s*:\s*none/);
    expect(css).not.toMatch(/outline\s*:\s*0\b/);
  });
});

/**
 * Stage 6: the parts of the acceptance criteria that live in the stylesheet and
 * cannot be observed from jsdom.
 *
 * These are static measurements of the source, not of a rendered page. They
 * exist so a regression is caught by `pnpm test` rather than by a person with a
 * browser at 320px — not to replace that check, which still has to happen for
 * anything a text file cannot say.
 */

/** sRGB hex -> WCAG relative luminance. */
function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);

  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );

  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG 2.x contrast ratio between two opaque sRGB hex colours. */
function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  );

  return (lighter + 0.05) / (darker + 0.05);
}

/** The body-text threshold. WCAG 1.4.3 AA. */
const AA_TEXT = 4.5;

/** The threshold for large text and for graphical objects. WCAG 1.4.11. */
const AA_LARGE = 3;

const CLUB_PAPER = '#f3eee5';
const CLUB_SURFACE = '#fffdf7';

/**
 * The declarations of every rule whose selector list contains `selector`.
 *
 * A plain `\.name\s*\{…\}` does not do: the file has rules that serve two
 * selectors at once — `.club-ladder__gap-value, .club-ladder__gap-tier` is one
 * rule, and a regex that stops at the first `{` reads the comma as if the body
 * began there, then finds nothing. Each selector in a list is checked on its
 * own, and a selector that appears in several rules gets all of their
 * declarations, so a test reads the real accumulated treatment.
 */
function ruleBody(selector: string): string {
  const bodies: string[] = [];

  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorList = match[1].split(',').map((part) => part.trim());

    if (selectorList.some((part) => new RegExp(`(^|\\s|,)${selector}(\\s|,|$|:|\\.)`).test(part))) {
      bodies.push(match[2]);
    }
  }

  return bodies.join('\n');
}

describe('Stage 6 club-barrio contrast floor', () => {
  it.each([
    ['club ink on the card surface', '#27201d', CLUB_SURFACE, AA_TEXT],
    ['club ink on the page', '#27201d', CLUB_PAPER, AA_TEXT],
    ['club secondary ink on the card surface', '#6f625b', CLUB_SURFACE, AA_TEXT],
    ['club secondary ink on the page', '#6f625b', CLUB_PAPER, AA_TEXT],
    ['cherry on the card surface, the primary label', '#a9362b', CLUB_SURFACE, AA_TEXT],
    ['cherry on the page', '#a9362b', CLUB_PAPER, AA_TEXT],
    ['cherry-dark, the outline button and the error text', '#74231d', CLUB_SURFACE, AA_TEXT],
    ['cherry-dark on the page', '#74231d', CLUB_PAPER, AA_TEXT],
    // The two tones Stage 6 added, measured rather than eyeballed.
    ['club success, the earned amount and the stock badge', '#1c6b45', CLUB_SURFACE, AA_TEXT],
    ['club success-strong gold, the reached rung marker', '#8a5f1f', CLUB_SURFACE, AA_LARGE],
    // The focus ring, measured on both backgrounds it can land on.
    ['club focus ring on the card surface', '#1e67b1', CLUB_SURFACE, AA_LARGE],
    ['club focus ring on the page', '#1e67b1', CLUB_PAPER, AA_LARGE],
  ])('%s clears %s:1', (_label, foreground, background, minimum) => {
    const ratio = contrastRatio(foreground as string, background as string);

    expect(
      ratio,
      `${foreground} on ${background} is ${ratio.toFixed(2)}:1, below the ${minimum}:1 floor`,
    ).toBeGreaterThanOrEqual(minimum as number);
  });

  it('keeps no design-system tone in a foreground role on the club surfaces', () => {
    // The values the design system resolves these to, which were the measured
    // failures that forced the remaps in `.customer-web`. Pinned so a future
    // unmapping is a deliberate act with a stated reason.
    expect(contrastRatio('#cf8a00', CLUB_SURFACE)).toBeLessThan(AA_TEXT);
    expect(contrastRatio('#9e9994', CLUB_SURFACE)).toBeLessThan(AA_TEXT);
    expect(contrastRatio('#9e9994', CLUB_PAPER)).toBeLessThan(AA_TEXT);
    expect(contrastRatio('#299236', CLUB_SURFACE)).toBeLessThan(AA_TEXT);

    // And so `.customer-web` must actually remap all four. Amber was a text
    // colour in three rules — the active history filter, the reward cost and the
    // remaining balance — every one of them a figure the customer reads to
    // decide something.
    const scope = /\.customer-web\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

    expect(scope).toMatch(/--brand-500:\s*var\(--club-cherry\)/);
    expect(scope).toMatch(/--brand-50:\s*var\(--club-paper\)/);
    expect(scope).toMatch(/--text-muted:\s*var\(--club-ink-soft\)/);
    expect(scope).toMatch(/--success:\s*var\(--club-success\)/);
  });

  it('reaches 3:1 for a disabled button label rather than 2:1', () => {
    // `.btn:disabled` was 0.5 alpha over the page, which composited the cherry
    // label down to 2.25:1 — the "Registrando…" and "Entrando…" labels were
    // unreadable while the request they describe was in flight. Inactive
    // controls are exempt from 1.4.3, but a label nobody can read is not a
    // working affordance, so the floor is asserted anyway.
    const opacity = Number(/^\.btn:disabled\s*\{[\s\S]*?opacity:\s*([\d.]+);/m.exec(css)?.[1]);

    expect(opacity).toBeGreaterThanOrEqual(0.7);

    // Cherry at that alpha, over the page background.
    const paper = [1, 3, 5].map((offset) => parseInt(CLUB_PAPER.slice(offset, offset + 2), 16));
    const composited = `#${[169, 54, 43]
      .map((channel, index) =>
        Math.round(channel * opacity + paper[index] * (1 - opacity))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`;

    expect(contrastRatio(composited, CLUB_PAPER)).toBeGreaterThanOrEqual(AA_LARGE);
  });
});

describe('Stage 6 club-barrio responsive floor', () => {
  it('gives every action a 44px target', () => {
    // Counted from the rules, not from a browser: any rule that sizes a control
    // has to reach the floor or state why it cannot.
    const minHeights = [
      '.btn',
      '.filter-tab',
      '.club-back-link',
      '.club-qr-dock__button',
      '.club-qr-sheet__close',
      '.club-qr__retry',
      '.logout-btn',
      '.club-register__optional-summary',
      '.club-consent__row',
    ];

    for (const selector of minHeights) {
      const declared = /min-height:\s*(\d+)px/.exec(ruleBody(selector))?.[1];

      // 44px is the floor and 48px clears it. A rule with no `min-height` at all
      // has to justify itself some other way, and none of these do.
      expect(declared, `${selector} declares no pixel min-height`).toBeDefined();
      expect(Number(declared), `${selector} min-height is ${declared}px`).toBeGreaterThanOrEqual(44);
    }

    // The filter tabs were the real failure: 10px of padding plus a 15.6px line
    // plus 3px of border is about 38.6px, so every filter was under the target.
    expect(ruleBody('.filter-tab')).toMatch(/min-height:\s*44px/);
    expect(ruleBody('.filter-tab')).toMatch(/min-width:\s*0/);
  });

  it('lets the three filter tabs fit 320px instead of forcing the page wide', () => {
    // The mechanism: a zero min-width so the labels wrap, and no `nowrap`.
    expect(ruleBody('.filter-tab')).not.toMatch(/white-space:\s*nowrap/);
  });

  it('breaks a long unbreakable word anywhere rather than per component', () => {
    // Merchant business names, reward names, tier names, movement notes and
    // member uuids all arrive as data. The rule lives once, at the app root, so
    // the next component inherits it.
    const scope = /\.customer-web\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

    expect(scope).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('gives the numeric figures tabular figures', () => {
    // Balances, point amounts, ladder thresholds and the member id. Each of
    // these is compared against another, either by eye down a column or aloud.
    const tabular = [
      '.club-pass__balance-value',
      '.club-pass__meta-item dd',
      '.club-ladder__gap-value',
      '.club-ladder__rung-threshold',
      '.movement__points',
      '.movement__balance',
      '.reward-card__cost',
      '.reward-card__stock',
      '.confirm-balance__value',
      '.confirm-available',
      '.club-qr__id-value',
    ];

    for (const selector of tabular) {
      expect(ruleBody(selector), `${selector} has no tabular figures`).toMatch(
        /font-variant-numeric:\s*tabular-nums/,
      );
    }
  });

  it('drops the fixed minimum that a stacked layout cannot honour', () => {
    // `min-width: 9.5rem` on the entry actions was meant to stop two side-by-side
    // buttons squeezing. Stacked, it is a hard 152px floor that a narrow
    // viewport cannot honour, so the button ends up wider than its own frame.
    const mobile = /@media \(max-width: 47\.99rem\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

    expect(mobile).toMatch(/\.club-entry__action\s*\{[\s\S]*?min-width:\s*0/);
  });
});

describe('Stage 6 club-barrio motion floor', () => {
  it('only declares keyframes that something animates', () => {
    // The stylesheet carried `pulse`, `countUp`, `slideDown` and `glowPulse` for
    // a design that no longer exists. Beyond being dead weight, they made the
    // reduced-motion story look like it had four more animations to cover than
    // it did. Nothing references them now, and a new orphan fails here.
    const declared = [...css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
    const animated = [...css.matchAll(/animation:\s*([A-Za-z0-9_-]+)/g)].map((match) => match[1]);

    expect(declared.length).toBeGreaterThan(0);

    const orphans = declared.filter((name) => !animated.includes(name)).sort();

    expect(orphans).toEqual([]);
  });

  it('kills animations outright under reduced motion, for the whole subtree', () => {
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

    // `animation: none`, not a shortened duration: a 0.01ms iteration is still an
    // iteration, and `none` leaves nothing running at all.
    expect(block).toMatch(/animation:\s*none\s*!important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    // The pseudo-elements, or a `::before` can animate past its parent's back.
    expect(block).toMatch(/\.customer-web \*::before/);
    expect(block).toMatch(/\.customer-web \*::after/);
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
