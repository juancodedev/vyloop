// @vitest-environment node

/**
 * Every navigation item must point at a route that exists.
 *
 * The sidebar has carried a "Configuración" link to `/dashboard/settings` since
 * before that route was created, so the item 404'd in production for anyone who
 * clicked it. Nothing caught it: a link is a string, the router is dynamic, and a
 * page that does not exist is not an error anywhere in the build.
 *
 * The test walks the navigation config and resolves each `href` against the App
 * Router's `page.tsx` files. It cannot tell whether a route renders correctly, but
 * it can tell whether it is there, and that is the failure that actually happens.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const appDir = new URL('../app/', import.meta.url).pathname;
const navigationPath = new URL('../lib/navigation.ts', import.meta.url).pathname;
const navigation = readFileSync(navigationPath, 'utf8');

/** The App Router's dynamic directory names, e.g. `[id]`. */
function dynamicDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\[.+\]$/.test(entry.name))
    .map((entry) => entry.name);
}

function routeExists(href: string): boolean {
  // A hash is an action and an external URL leaves the app; neither is a route.
  if (href.startsWith('#') || href.startsWith('http')) return true;

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

const hrefs = [...navigation.matchAll(/href:\s*'([^']+)'/g)].map((match) => match[1]);

describe('dashboard navigation', () => {
  it('has navigation items to check', () => {
    // Everything below is vacuously true with zero links parsed. If the config is
    // renamed or the format changes, this fails first rather than reporting that
    // a navigation with no dead links has been verified.
    expect(hrefs.length).toBeGreaterThan(5);
  });

  it('points every item at a route that exists', () => {
    // This is the whole test. A dead sidebar link is invisible in CI and obvious
    // to the first person who clicks it in production.
    const dead = hrefs.filter((href) => !routeExists(href));
    expect(dead).toEqual([]);
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
