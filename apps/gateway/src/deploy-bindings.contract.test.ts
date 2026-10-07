import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Which workers read `DATABASE_URL`, and which ones the deploy teaches it to.
 *
 * The omission this guards against is not visible anywhere except in production.
 * A worker whose `wrangler.jsonc` does not declare the var, that no deploy job
 * injects, and that calls `createDb(c.env.DATABASE_URL)` anyway, passes every local
 * check and fails on its first query in production with a 500 from `set_config`.
 *
 * That is not hypothetical: four workers were in that state, and
 * `/v1/communication/templates` was answering 500 because of it.
 */
const repoRoot = join(__dirname, '..', '..', '..');
const workersRoot = join(repoRoot, 'workers');

function workerNames(): string[] {
  return readdirSync(workersRoot).filter((entry) => {
    try {
      return statSync(join(workersRoot, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Workers that read the connection string out of their environment. */
function workersReadingDatabaseUrl(): string[] {
  return workerNames()
    .filter((worker) => {
      const srcDir = join(workersRoot, worker, 'src');
      let files: string[];
      try {
        files = readdirSync(srcDir);
      } catch {
        return false;
      }

      return files
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .some((f) =>
          /createDb\(\s*(?:c\.env|env)\.DATABASE_URL\s*\)/.test(
            readFileSync(join(srcDir, f), 'utf8'),
          ),
        );
    })
    .sort();
}

/** The `case` arms in the deploy job that add `--var DATABASE_URL`. */
function workersDeployedWithDatabaseUrl(): string[] {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'deploy.yml'), 'utf8');

  // Arms are `identity)` or `analytics | automation | wallet)`, so the character
  // class has to allow spaces — an earlier version of this guard excluded them and
  // silently read the multi-worker arm as absent, which is the same failure it
  // exists to catch, one level up.
  const arms = workflow.match(/^\s*([a-z| ]+)\)\s*$/gm) ?? [];

  return arms
    .flatMap((arm) => arm.trim().replace(')', '').split('|'))
    .map((name) => name.trim())
    .filter((name) => /^[a-z][a-z-]*$/.test(name))
    .sort();
}

describe('deploy bindings', () => {
  const readers = workersReadingDatabaseUrl();
  const deployed = workersDeployedWithDatabaseUrl();

  it('finds the workers that read DATABASE_URL, so the assertion below is not vacuous', () => {
    // A guard that discovers zero workers passes forever and protects nothing.
    expect(readers.length).toBeGreaterThan(2);
    expect(readers).toContain('communication');
  });

  /**
   * The whole point.
   *
   * A worker that reads `c.env.DATABASE_URL` and is not taught the var by the deploy
   * reaches production with a 500 on its first query. Nothing local shows it: the
   * worker compiles, the type is declared, the tests mock the database, and
   * `wrangler deploy` happily publishes a worker that cannot reach anything.
   */
  it('teaches the deploy to inject DATABASE_URL for every worker that reads it', () => {
    const missing = readers.filter((worker) => !deployed.includes(worker));

    expect(
      missing,
      `These workers call createDb(c.env.DATABASE_URL) but the deploy job does not ` +
        `pass --var DATABASE_URL for them: ${missing.join(', ')}. They will answer 500 ` +
        `on their first query in production. Add them to the \`case\` in deploy.yml.`,
    ).toEqual([]);
  });
});