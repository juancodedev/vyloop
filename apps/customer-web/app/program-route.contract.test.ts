// @vitest-environment node

/**
 * The programme page must open at `/program`, with no file extension.
 *
 * ## What changed under the OpenNext Worker
 *
 * The page used to live at `public/program/index.html`, reached through a Next
 * rewrite to that path. Under the Workers static-assets layer the directory form
 * is what a request for `/program` resolves against: the assets layer answers
 * with a `307` to `/program/` before the app sees the request, so the URL that
 * went to Google's publishing review moved in the address bar.
 *
 * A rewrite is not the escape hatch either. Rewriting to `/program/index.html`
 * returned Next's own 404: a public file is served by the assets binding, and a
 * rewrite does not hand a request to it. Verified by request, not assumed.
 *
 * What works is the plain form. `public/program.html` is served at `/program`
 * directly by the assets layer — `200`, no redirect, no rewrite — which is what
 * the static-assets `auto-trailing-slash` handling does for `<name>.html`.
 *
 * This test guards the two halves of that: the file is in a form the assets
 * layer serves at the clean URL, and no rewrite or `_redirects` file quietly
 * claims the job back.
 *
 * The build-level proof is a real `cf:build` plus a served request; a test
 * cannot substitute for it, which is exactly how the `_redirects` version passed
 * CI and still shipped a 404.
 */

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const publicDir = new URL('../public/', import.meta.url).pathname;
const config = readFileSync(new URL('../next.config.mjs', import.meta.url).pathname, 'utf8');

describe('programme page routing', () => {
  it('ships the page in the form the assets layer serves at /program', () => {
    expect(existsSync(`${publicDir}program.html`)).toBe(true);
  });

  it('does not ship the directory form that redirects /program to /program/', () => {
    // `program/index.html` makes the assets layer answer `/program` with a 307 to
    // `/program/`. The page loads, but the URL is not the one that was published.
    expect(existsSync(`${publicDir}program/index.html`)).toBe(false);
  });

  it('does not rewrite to the public file, which the app cannot serve', () => {
    // Rewriting to `/program/index.html` produced Next's 404: the assets binding
    // serves public files, and a rewrite does not reach it.
    expect(config).not.toMatch(/program\/index\.html/);
  });

  it('does not rely on a `_redirects` file', () => {
    // `_redirects` is a Pages feature. A Worker deployment does not consult it:
    // the file gets deployed, looks correct in the build output, and does nothing.
    expect(existsSync(`${publicDir}_redirects`)).toBe(false);
  });
});
