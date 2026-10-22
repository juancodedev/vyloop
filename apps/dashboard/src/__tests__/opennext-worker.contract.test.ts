// @vitest-environment node

/**
 * The dashboard builds and deploys as a Cloudflare Worker, not as a Pages project.
 *
 * The migration is easy to half-do: adding the adapter while leaving
 * `@cloudflare/next-on-pages` in `package.json` installs both, and leaving
 * `export const runtime = 'edge'` on a page keeps a directive the new runtime
 * does not want. Neither breaks a test, and neither breaks `next build` — the
 * first surfaces at deploy time as a confusing error, the second as a route that
 * behaves differently from its neighbours.
 *
 * So this reads the sources instead of trusting the migration to have finished.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP_ROOT = join(__dirname, '..', '..');
const SRC_APP = join(APP_ROOT, 'src', 'app');

function filesUnder(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      filesUnder(path, found);
    } else {
      found.push(path);
    }
  }
  return found;
}

describe('the dashboard is built by the OpenNext adapter', () => {
  it('declares the adapter and no longer depends on next-on-pages', () => {
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };

    expect(all['@opennextjs/cloudflare']).toBeDefined();
    expect(all['@cloudflare/next-on-pages']).toBeUndefined();
  });

  it('builds with the adapter, not with next-on-pages', () => {
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['cf:build']).toBe('opennextjs-cloudflare build');
    expect(Object.values(pkg.scripts ?? {}).join(' ')).not.toContain('next-on-pages');
  });

  it('names the Worker the wrangler config deploys to, with assets', () => {
    const config = JSON.parse(
      readFileSync(join(APP_ROOT, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
    ) as {
      name?: string;
      main?: string;
      assets?: { directory?: string; binding?: string };
      compatibility_flags?: string[];
    };

    expect(config.name).toBe('vyloop-dashboard');
    expect(config.main).toBe('.open-next/worker.js');
    expect(config.assets).toEqual({ directory: '.open-next/assets', binding: 'ASSETS' });
    expect(config.compatibility_flags).toContain('nodejs_compat');
  });

  it('leaves no edge runtime declaration under src/app', () => {
    const offenders = filesUnder(SRC_APP).filter((path) =>
      /export\s+const\s+runtime\s*=\s*['"]edge['"]/.test(readFileSync(path, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });
});
