// @vitest-environment node

/**
 * Every navigation item must point at a route that exists.
 *
 * The sidebar has carried a "Configuración" link to `/dashboard/settings` since
 * before that route was created, so the item 404'd in production for anyone who
 * clicked it. Nothing caught it: a link is a string, the router is dynamic, and a
 * page that does not exist is not an error anywhere in the build.
 *
 * The test resolves every internal `href` in the codebase against the App
 * Router's `page.tsx` files. It cannot tell whether a route renders correctly, but
 * it can tell whether it is there, and that is the failure that actually happens.
 *
 * ## It reads the components too, not only the config
 *
 * It originally walked `lib/navigation.ts` alone, and that was a guard with a
 * blind spot big enough to walk through twice. A `Catálogo de Recompensas` link
 * declared inside `dashboard/page.tsx` pointed at `/dashboard/rewards` while the
 * page lives at `/dashboard/loyalty/rewards` — a dead link in production that the
 * test reported as clean, because a link written in a component is not a link
 * written in the config. The earlier `/dashboard/settings` 404 had the same
 * shape.
 *
 * So the hrefs come from both places now, and the source of each is reported when
 * something is dead, because "which file" is the question a reader has first.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const appDir = new URL('../app/', import.meta.url).pathname;
const srcDir = new URL('../', import.meta.url).pathname;
/** Every `.tsx` under `src/`, so a link in a component is found as well as one in the config. */
function tsxFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const hrefs: Array<{ href: string; file: string }> = tsxFiles(srcDir)
  // This file quotes hrefs as its own fixtures; reading them back would report
  // `/x` and `/nope` as dead links in the product.
  .filter((file) => !file.endsWith('navigation.contract.test.ts'))
  .flatMap((file) =>
    // Both quote styles on purpose. A single-quote-only pattern matches the config
    // (`href: '/x'`) and silently skips every JSX link (`href="/x"`), which is the
    // half that carries the dead links. The version of this that looked for `'` only
    // reported a clean run while a component link pointed at a page that does not
    // exist — the exact failure it was written to prevent.
    [...readFileSync(file, 'utf8').matchAll(/href[:=]\s*(['"])([^'"]+)\1/g)].map((match) => ({
      href: match[2]!,
      file: file.slice(srcDir.length),
    })),
  );

/** The App Router's dynamic directory names, e.g. `[id]`. */
function dynamicDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\[.+\]$/.test(entry.name))
    .map((entry) => entry.name);
}

function routeExists(rawHref: string): boolean {
  // A hash is an action and an external URL leaves the app; neither is a route.
  if (rawHref.startsWith('#') || rawHref.startsWith('http')) return true;

  // A query string is not a path segment. `/login?signup=true` is served by
  // `/login`, and treating the whole string as a path reported it dead.
  const href = rawHref.split('?')[0]!.split('#')[0]!;
  if (href === '') return existsSync(join(appDir, 'page.tsx'));

  const relative = href.replace(/^\//, '');
  if (relative === '') return existsSync(join(appDir, 'page.tsx'));

  if (existsSync(join(appDir, relative, 'page.tsx'))) return true;

  // A dynamic segment cannot be resolved statically, so the link is checked by
  // whether its parent serves one. `/dashboard/customers/anything` is served by
  // `/dashboard/customers/[id]`.
  const segments = relative.split('/');
  segments.pop();
  const parent = join(appDir, ...segments);

  return dynamicDirs(parent).some((name) => existsSync(join(parent, name, 'page.tsx')));
}

describe('dashboard navigation', () => {
  it('has links to check, from more than one place', () => {
    // Everything below is vacuously true with zero links parsed. If the config is
    // renamed or the format changes, this fails first rather than reporting that
    // a navigation with no dead links has been verified.
    expect(hrefs.length).toBeGreaterThan(5);

    // The regression this test exists to prevent: a guard that only reads the
    // config passes while a component link is dead. Requiring links from more
    // than the config file makes that state impossible to reach silently.
    expect(new Set(hrefs.map((entry) => entry.file)).size).toBeGreaterThan(1);
  });

  it('points every link at a route that exists', () => {
    // This is the whole test. A dead link is invisible in CI and obvious to the
    // first person who clicks it in production. Reported with the file it came
    // from, because a bare href sends the reader looking for the wrong one.
    const dead = hrefs.filter((entry) => !routeExists(entry.href));
    expect(dead.map((entry) => `${entry.file} -> ${entry.href}`)).toEqual([]);
  });

  it('resolves the paths it is asked about', () => {
    // The resolver itself. Without it, a bug in `routeExists` would report every
    // link as either fine or dead regardless of the app.
    expect(routeExists('/dashboard')).toBe(true);
    expect(routeExists('/dashboard/loyalty')).toBe(true);
    expect(routeExists('/dashboard/loyalty/config')).toBe(true);
    expect(routeExists('/dashboard/customers/anything')).toBe(true);
    expect(routeExists('#')).toBe(true);

    expect(routeExists('/dashboard/settings-does-not-exist')).toBe(false);
    expect(routeExists('/nope')).toBe(false);
  });

  it('finds the routes the sidebar advertises by walking the app directory', () => {
    // Guards the assumption that `page.tsx` is the App Router's file name here.
    // If the convention changed, every link would read as dead and the failure
    // would look like the app had lost its navigation rather than a moved file.
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name === 'page.tsx') found.push(join(dir, entry.name));
      }
    };
    walk(appDir);

    expect(found.length).toBeGreaterThan(10);
  });
});
