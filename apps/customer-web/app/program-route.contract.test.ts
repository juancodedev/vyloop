// @vitest-environment node

/**
 * The programme page must open at `/program` with no file extension.
 *
 * Next.js serves `public/` at the root but does not resolve a directory index,
 * so `public/program/index.html` is reachable only at `/program/index.html`. That
 * is the URL that went to Google's publishing review, and a link carrying
 * `.html` reads as an unfinished deployment.
 *
 * The fix is a Cloudflare Pages rewrite rather than a Next rewrite, because it
 * does not depend on how `@cloudflare/next-on-pages` happens to compile a
 * `rewrites()` entry this release. A rule that depends on the bundler is a rule
 * that can quietly stop working.
 */

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const publicDir = new URL('../public/', import.meta.url).pathname;
const redirects = readFileSync(`${publicDir}_redirects`, 'utf8');

/** The rules, without the comments that explain them. */
const rules = redirects
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

describe('programme page routing', () => {
  it('rewrites /program to the page', () => {
    const rule = rules.find((line) => line.startsWith('/program '));
    expect(rule).toBeDefined();
    expect(rule).toMatch(/^\/program\s+\/program\/index\.html\s+200$/);
  });

  it('uses 200 so the address bar keeps the clean path', () => {
    // A bare 301/302 would work and still leave the reader on the `.html` URL,
    // which is the exact thing this rule exists to stop.
    const rule = rules.find((line) => line.startsWith('/program ')) ?? '';
    const status = rule.split(/\s+/)[2];
    expect(status).toBe('200');
  });

  it('points at a file that exists', () => {
    // A rewrite to a missing target is a 404 wearing a clean path, which is
    // worse than the `.html` URL it replaced: it looks deliberate.
    for (const rule of rules) {
      const [, target] = rule.split(/\s+/);
      expect(existsSync(`${publicDir}${target.replace(/^\//, '')}`)).toBe(true);
    }
  });

  it('does not shadow the application itself', () => {
    // A catch-all here would swallow every Next route, including /login and
    // /register, and the failure would look like the app being down.
    for (const rule of rules) {
      expect(rule).not.toMatch(/^\/\*|\/login|\/register|\/profile/);
    }
  });
});
