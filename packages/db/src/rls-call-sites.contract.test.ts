// @vitest-environment node

/**
 * Runtime code sets the tenant only through `withTenantTransaction`.
 *
 * `set_config(..., true)` lasts for the transaction it runs in. Issued as a
 * statement of its own (`withRls`, `openTenantSession`, a bare
 * `db.execute(setCurrentBusinessId(...))`) it ends with that statement, and the
 * queries after it run with no tenant: today they still return rows, because
 * the policies are not enforced, and the day they are, they return nothing or
 * fail. The helper is the one place that opens the transaction, sets the tenant
 * on it and hands the caller that handle, so this test keeps every other way
 * out of the runtime code.
 *
 * It reads source, not behavior: each worker's own tests prove its queries run
 * on the transaction handle.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** A call that sets the tenant outside the helper. */
const RAW_TENANT_SETTING =
  /\b(withRls|openTenantSession|setCurrentBusinessId|setCurrentTenantId)\(/;

/**
 * Files allowed to set the tenant by hand, and why.
 *
 * Signup cannot use the helper at all; the cron entries are debts that end in
 * Unit 3, and the last test fails once one of them is no longer needed.
 */
const ALLOWED: Record<string, string> = {
  'workers/identity/src/business-signup.ts':
    'Signup creates the business inside its transaction, so the id does not exist before the transaction opens; it sets the tenant on that transaction right after the insert.',
  'workers/automation/src/helpers.ts':
    'Defines withRls for the cron handlers, which loop over every business and move to per-tenant transactions in Unit 3.',
  'workers/automation/src/cron-handler.ts':
    'Cross-tenant cron loops; they move to per-tenant transactions in Unit 3.',
};

/** Runtime source files of the workers and the gateway, as git tracks them. */
function runtimeSources(): string[] {
  const tracked = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      ':(glob)workers/*/src/**',
      'apps/gateway/src',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return tracked
    .split('\n')
    .filter(
      (path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts'),
    );
}

describe('tenant settings in runtime code', () => {
  it('finds the runtime sources it is meant to read', () => {
    // A path change that found nothing would make the next test pass vacuously.
    expect(runtimeSources().length).toBeGreaterThan(50);
  });

  it('go through withTenantTransaction everywhere but the listed exceptions', () => {
    const offenders = runtimeSources().filter(
      (path) =>
        !(path in ALLOWED) &&
        readFileSync(join(REPO_ROOT, path), 'utf8')
          .split('\n')
          // Comments may name the old helpers when they explain the change.
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .some((line) => RAW_TENANT_SETTING.test(line)),
    );

    expect(offenders).toEqual([]);
  });

  it('lists only exceptions that still set the tenant by hand', () => {
    // An exception that no longer needs it is an open door: remove it.
    const stale = Object.keys(ALLOWED).filter(
      (path) => !RAW_TENANT_SETTING.test(readFileSync(join(REPO_ROOT, path), 'utf8')),
    );

    expect(stale).toEqual([]);
  });
});
