import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const configPath = join(__dirname, '..', '..', 'next.config.mjs');
const config = readFileSync(configPath, 'utf8');

/**
 * The build-time fence.
 *
 * A production build with no gateway URL compiles cleanly, passes every test, and
 * fails only in a visitor's browser. That is exactly how `http://localhost:8787`
 * shipped into a deployed bundle and broke the public login page with
 * `ERR_CONNECTION_REFUSED`. `next.config.mjs` is the last place that can still
 * stop it, so the rule it enforces is pinned here rather than left to a comment.
 */
describe('next.config.mjs gateway guard', () => {
  it('refuses a production build with no gateway URL', () => {
    expect(config).toContain('NEXT_PUBLIC_API_URL is required for a production build');
  });

  it('refuses a production build whose gateway URL is localhost', () => {
    // Guarding only the empty case would still let a pasted development address
    // through, which fails in exactly the same way and is the easier mistake.
    expect(config).toContain('points at localhost');
  });

  it('covers the loopback spellings a pasted address actually takes', () => {
    expect(config).toMatch(/localhost\|127\\\.0\\\.0\\\.1/);
  });

  it('only enforces the rule for production builds', () => {
    // A guard that also ran in development would make `next dev` unusable, and
    // the fix would be to delete the guard.
    expect(config).toMatch(/NODE_ENV === 'production'/);
  });
});
