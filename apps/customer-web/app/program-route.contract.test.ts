// @vitest-environment node

/**
 * The programme page must open at `/program`, with no file extension.
 *
 * Next.js serves `public/` at the root but does not resolve a directory index,
 * so `public/program/index.html` is reachable only at `/program/index.html`.
 * That is the URL that went to Google's publishing review, and a link carrying
 * `.html` reads as an unfinished deployment to anyone opening it.
 *
 * ## Why this is guarded here and not in `public/_redirects`
 *
 * `@cloudflare/next-on-pages` emits a `_worker.js`, which puts the project in
 * Cloudflare's advanced mode. In advanced mode Pages ignores `_redirects` — the
 * file is uploaded, it sits in the build output, and it does nothing. A build
 * that looks correct on disk can still 404 in production for that reason, so
 * the rule has to live where the request is actually routed: the Worker.
 *
 * This test therefore asserts the Next rewrite exists, and asserts no
 * `_redirects` file is quietly claiming the job. The build-level proof is a
 * real `pages:build` plus a served request; a test cannot substitute for it,
 * which is exactly how the `_redirects` version passed CI and still shipped a
 * 404.
 */

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const publicDir = new URL('../public/', import.meta.url).pathname;
const config = readFileSync(new URL('../next.config.mjs', import.meta.url).pathname, 'utf8');

describe('programme page routing', () => {
  it('rewrites /program to the page', () => {
    expect(config).toMatch(/source:\s*'\/program'/);
    expect(config).toMatch(/destination:\s*'\/program\/index\.html'/);
  });

  it('routes it in the worker, where the request is actually handled', () => {
    // A `public/_redirects` file is ignored in advanced mode. If one reappears it
    // will be deployed, look correct in the build output, and do nothing.
    expect(existsSync(`${publicDir}_redirects`)).toBe(false);
  });

  it('points at a file that exists', () => {
    // A rewrite to a missing file is a 404 wearing a clean path, which is worse
    // than the URL it replaced: it looks deliberate.
    expect(existsSync(`${publicDir}program/index.html`)).toBe(true);
  });

  it('does not rewrite the application routes', () => {
    // A catch-all here would swallow every route, including /login and
    // /register, and the failure would look like the app being down.
    const destinations = [...config.matchAll(/destination:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(destinations).toEqual(['/program/index.html']);
    for (const destination of destinations) {
      expect(destination).not.toMatch(/\/login|\/register|\/profile/);
    }
  });
});
