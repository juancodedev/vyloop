// @vitest-environment node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
const appDir = new URL('./', import.meta.url).pathname;

/** Every `.ts`/`.tsx` under `app/`, so the check follows new components automatically. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(path);

    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/**
 * Club class names actually applied to elements, taken from `className` values
 * only. A loose scan for `club-` would also match the `--club-*` custom
 * properties and the `id="…-title"` hooks, neither of which is a class.
 */
function clubClassesInUse(): Set<string> {
  const used = new Set<string>();

  for (const file of sourceFiles(appDir)) {
    const source = readFileSync(file, 'utf8');

    for (const match of source.matchAll(/className=\{?['"`]([^'"`]+)['"`]\}?/g)) {
      for (const raw of match[1].split(/[\s{}$]+/)) {
        const name = raw.trim();
        if (/^club-[a-z0-9_-]+$/.test(name)) used.add(name);
      }
    }
  }

  return used;
}

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

describe('club-barrio markup and stylesheet agree', () => {
  it('has a rule for every club class the pages apply', () => {
    const missing = [...clubClassesInUse()].filter((name) => !css.includes(`.${name}`)).sort();

    expect(missing).toEqual([]);
  });

  it('finds the classes it is meant to find', () => {
    // Guards the guard: if the extraction above ever stops matching, the test
    // above would pass vacuously on an empty set and stop protecting anything.
    const used = clubClassesInUse();

    expect(used.size).toBeGreaterThan(20);
    expect(used).toContain('club-login__form');
    expect(used).toContain('club-register__submit');
    expect(used).toContain('club-entry__actions');
  });
});
