// @vitest-environment node

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');

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
