import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CHILD_CLEARS,
  CHILD_DELETES,
  COUNT_SQL,
  CUSTOMER_CLEARS,
  applyStatements,
  parseArgs,
  run,
} from './anonymise-deleted-customers.mjs';

const repoRoot = new URL('../', import.meta.url).pathname;

/** A pool that records every statement and answers the count query. */
function fakePool(count = 3) {
  const statements = [];
  return {
    statements,
    async query(sql) {
      statements.push(sql.trim());
      if (sql === COUNT_SQL) return { rows: [{ business_id: 'b1', customers: String(count) }] };
      return { rows: [], rowCount: count };
    },
    release() {},
    async connect() {
      return this;
    },
    async end() {},
  };
}

const camelToSnake = (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe('the backfill of customers deleted before anonymisation existed', () => {
  it('only reports unless --apply is passed', () => {
    expect(parseArgs([])).toEqual({ apply: false });
    expect(parseArgs(['--apply'])).toEqual({ apply: true });
    expect(() => parseArgs(['--aply'])).toThrow(/--aply/);
  });

  it('writes nothing in a dry run', async () => {
    const pool = fakePool();

    const report = await run({ apply: false, pool });

    expect(report).toEqual({ applied: false, pending: 3, byBusiness: [{ business_id: 'b1', customers: 3 }] });
    expect(pool.statements).toEqual([COUNT_SQL.trim()]);
  });

  it('applies every statement inside one transaction', async () => {
    const pool = fakePool();

    const report = await run({ apply: true, pool });

    expect(report.applied).toBe(true);
    expect(pool.statements[1]).toBe('BEGIN');
    expect(pool.statements.slice(2, -1)).toEqual(applyStatements().map((s) => s.trim()));
    expect(pool.statements.at(-1)).toBe('COMMIT');
  });

  it('rolls back and rethrows when a statement fails', async () => {
    const pool = fakePool();
    const original = pool.query.bind(pool);
    pool.query = async (sql) => {
      if (sql.includes('DELETE FROM push_subscriptions')) throw new Error('boom');
      return original(sql);
    };

    await expect(run({ apply: true, pool })).rejects.toThrow('boom');
    expect(pool.statements.at(-1)).toBe('ROLLBACK');
  });

  it('touches only customers already deleted that still hold personal data, and keeps deleted_at', () => {
    const [select] = applyStatements();

    expect(select).toMatch(/deleted_at IS NOT NULL/);
    for (const column of CUSTOMER_CLEARS) expect(select).toContain(`${column} IS NOT NULL`);
    expect(applyStatements().join('\n')).not.toMatch(/deleted_at\s*=/);
  });

  it('clears exactly what the worker clears on a delete today', () => {
    // The backfill is the same rule applied late. If the worker starts
    // clearing another column, this fails until the backfill does too.
    const worker = readFileSync(join(repoRoot, 'workers/customer/src/account-deletion.ts'), 'utf8');
    const customerSet = /\.update\(customers\)\s*\.set\(\{([\s\S]*?)\}\)/.exec(worker)[1];
    const workerCustomerColumns = [...customerSet.matchAll(/^\s*(\w+): null,/gm)].map((m) =>
      camelToSnake(m[1]),
    );
    const workerChildClears = Object.fromEntries(
      [...worker.matchAll(/tx\.update\((\w+)\)\.set\(\{(.*?)\}\)\.where/g)].map((m) => [
        camelToSnake(m[1]),
        [...m[2].matchAll(/(\w+):/g)].map((k) => camelToSnake(k[1])).sort(),
      ]),
    );
    const workerDeletes = [...worker.matchAll(/tx\.delete\((\w+)\)/g)].map((m) => camelToSnake(m[1]));

    expect([...CUSTOMER_CLEARS].sort()).toEqual(workerCustomerColumns.sort());
    expect(
      Object.fromEntries(Object.entries(CHILD_CLEARS).map(([t, cols]) => [t, Object.keys(cols).sort()])),
    ).toEqual(workerChildClears);
    expect([...CHILD_DELETES].sort()).toEqual(workerDeletes.sort());
  });

  it('is well-formed Postgres', async () => {
    const require = createRequire(join(repoRoot, 'packages/db/package.json'));
    const PgQueryModule = require('pg-query-emscripten');
    const Module = PgQueryModule.default ?? PgQueryModule;

    for (const sql of [COUNT_SQL, ...applyStatements()]) {
      const parser = await new Module();
      expect(parser.parse(sql).error, sql).toBeNull();
    }
  });
});
