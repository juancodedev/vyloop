// pnpm db:rls [-- --expect none|wallet|communication|growth|rest|all]
//
// Reports, for every table in `BUSINESS_ID_TABLES` and `TENANT_ID_TABLES`
// (`packages/db/src/rls.ts`), whether row-level security is enabled
// (`pg_class.relrowsecurity`), whether it is forced (`relforcerowsecurity`) and
// whether the `tenant_isolation` policy exists (`pg_policies`); and, for the role
// in `DATABASE_URL`, its name, its `rolbypassrls` and which listed tables it owns.
//
// Without `--expect` it is a report and exits 0 when the database could be read.
// With `--expect` it is the exit criterion of a rollout phase: every table the
// phase covers must have RLS on *and* the policy, every other listed table must
// have RLS off *and* no policy, and any difference exits 1 naming the table.
//
// Phases are cumulative, in rollout order: `wallet` (the `TENANT_ID_TABLES`,
// plus `push_campaigns`, see `RLS_BATCHES.wallet`), then the business tables in the batches of openspec tenant-isolation-rls 7.1
// — `communication`, `growth`, then `rest` (every business table left, so
// `rest` and `all` describe the same state). `none` expects nothing enabled.
//
// The role is reported, never judged: this script runs with the owner
// credential like the other operational scripts, so "owns tables" is the
// expected answer here and the answer to check for the workers' role.
//
// No third state. A database that cannot be reached, or that does not honour a
// read-only session, exits 1 with or without `--expect`: "I could not verify"
// is not a pass.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveDatabaseUrl } from './lib/database-url.mjs';
import { withReadOnlySession } from './lib/read-only-session.mjs';

export const RLS_SOURCE = 'packages/db/src/rls.ts';

/**
 * The business-table batches of the rollout (openspec 7.1). `rest` is derived:
 * every business table not named here, so a new table lands in the last batch
 * rather than in none.
 */
export const RLS_BATCHES = {
  // Business tables the wallet phase enables alongside the `TENANT_ID_TABLES`.
  // `push_campaigns` had RLS and the `tenant_isolation` policy in production
  // before the rollout started, applied outside any migration. Migration 0026
  // records it with the wallet tables, so every phase from `wallet` on expects
  // it enabled and `none` describes a database that predates that state.
  wallet: ['push_campaigns'],
  communication: ['message_log', 'whatsapp_templates', 'push_subscriptions'],
  growth: [
    'loyalty_programs',
    'membership_tiers',
    'points_transactions',
    'rewards',
    'reward_grants',
    'referrals',
    'checkins',
    'settled_payments',
    'pos_terminals',
  ],
};

/** Every accepted `--expect` value, in rollout order. */
export const EXPECTATIONS = ['none', 'wallet', 'communication', 'growth', 'rest', 'all'];

const USAGE = `usage: pnpm db:rls [-- --expect ${EXPECTATIONS.join('|')}]`;

/**
 * Load the table lists and the policy name from `rls.ts` itself.
 *
 * Over `tsx`, resolved from packages/db (which carries it, like `pg`), rather
 * than a copy of the lists: a copy would keep passing after a table was added
 * to `rls.ts`, which is exactly the table this script exists to catch.
 */
export async function loadRlsTables() {
  const require = createRequire(join(process.cwd(), 'packages/db/package.json'));
  const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
  const rls = await tsImport(pathToFileURL(join(process.cwd(), RLS_SOURCE)).href, import.meta.url);
  return {
    businessIdTables: [...rls.BUSINESS_ID_TABLES],
    tenantIdTables: [...rls.TENANT_ID_TABLES],
    policyName: rls.RLS_POLICY_NAME,
  };
}

export function parseArgs(argv) {
  let expectation = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    let value;
    if (arg === '--expect') {
      value = argv[i + 1];
      i += 1;
      if (value === undefined) throw new Error(`--expect needs a value. ${USAGE}`);
    } else if (arg.startsWith('--expect=')) {
      value = arg.slice('--expect='.length);
    } else {
      throw new Error(`unknown argument ${arg}. ${USAGE}`);
    }
    if (!EXPECTATIONS.includes(value)) {
      throw new Error(`unknown --expect value ${value}. ${USAGE}`);
    }
    expectation = value;
  }
  return { expectation };
}

/** The tables a phase expects enabled with the policy. */
export function expectedEnabled(expectation, lists) {
  for (const table of [
    ...RLS_BATCHES.wallet,
    ...RLS_BATCHES.communication,
    ...RLS_BATCHES.growth,
  ]) {
    if (!lists.businessIdTables.includes(table)) {
      throw new Error(`batch table ${table} is not in BUSINESS_ID_TABLES (${RLS_SOURCE})`);
    }
  }
  const batched = new Set([
    ...RLS_BATCHES.wallet,
    ...RLS_BATCHES.communication,
    ...RLS_BATCHES.growth,
  ]);
  const phases = [
    ['wallet', [...lists.tenantIdTables, ...RLS_BATCHES.wallet]],
    ['communication', RLS_BATCHES.communication],
    ['growth', RLS_BATCHES.growth],
    ['rest', lists.businessIdTables.filter((t) => !batched.has(t))],
  ];
  if (expectation === 'none') return new Set();
  if (expectation === 'all') return new Set([...lists.businessIdTables, ...lists.tenantIdTables]);

  const enabled = new Set();
  for (const [phase, tables] of phases) {
    for (const table of tables) enabled.add(table);
    if (phase === expectation) return enabled;
  }
  throw new Error(`unknown expectation ${expectation}`);
}

/** The catalog rows for the listed tables, read on a read-only session. */
async function readRlsCatalog(pool, { tables, policyName }) {
  const role = (
    await pool.query(
      'select current_user as role, r.rolbypassrls from pg_roles r where r.rolname = current_user',
    )
  ).rows[0];
  const classes = await pool.query(
    `select c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = current_schema() and c.relkind in ('r', 'p') and c.relname = any($1)`,
    [tables],
  );
  const policies = await pool.query(
    `select tablename from pg_policies
     where schemaname = current_schema() and tablename = any($1) and policyname = $2`,
    [tables, policyName],
  );
  return {
    role: { name: role.role, bypassRls: role.rolbypassrls },
    tables: classes.rows,
    policies: policies.rows.map((r) => r.tablename),
  };
}

/** Read the RLS catalog for the listed tables, or report that it could not be read. */
export async function observeRls(url, lists, { connectTimeoutMs, createPool } = {}) {
  const tables = [...lists.businessIdTables, ...lists.tenantIdTables];
  return withReadOnlySession(
    url,
    (pool) => readRlsCatalog(pool, { tables, policyName: lists.policyName }),
    { connectTimeoutMs, createPool },
  );
}

const onOff = (value) => (value ? 'on' : 'off');

/** Turn an observation into per-table rows, role facts, failures and an exit code. */
export function buildReport({ lists, observation, expectation }) {
  if (!observation.reachable) {
    return { reachable: false, error: observation.error, expectation, exitCode: 1 };
  }

  const expected = expectation === null ? null : expectedEnabled(expectation, lists);
  const byName = new Map(observation.tables.map((row) => [row.relname, row]));
  const withPolicy = new Set(observation.policies);
  const scoped = [
    ...lists.businessIdTables.map((table) => [table, 'business_id']),
    ...lists.tenantIdTables.map((table) => [table, 'tenant_id']),
  ];

  const failures = [];
  const tables = scoped.map(([table, scope]) => {
    const row = byName.get(table);
    const entry = {
      table,
      scope,
      present: row !== undefined,
      rls: row?.relrowsecurity === true,
      force: row?.relforcerowsecurity === true,
      policy: withPolicy.has(table),
      owned: row !== undefined && row.owner === observation.role.name,
      expected: expected === null ? null : expected.has(table),
    };

    if (expected !== null) {
      const found = `found rls=${onOff(entry.rls)}, policy=${entry.policy ? 'present' : 'missing'}`;
      if (!entry.present) {
        failures.push(`${table}: listed in rls.ts but missing from the database`);
      } else if (entry.expected && !(entry.rls && entry.policy)) {
        failures.push(`${table}: expected RLS on with the ${lists.policyName} policy, ${found}`);
      } else if (!entry.expected && (entry.rls || entry.policy)) {
        failures.push(`${table}: expected RLS off and no ${lists.policyName} policy, ${found}`);
      }
    }
    return entry;
  });

  return {
    reachable: true,
    expectation,
    policyName: lists.policyName,
    role: {
      name: observation.role.name,
      bypassRls: observation.role.bypassRls === true,
      ownedTables: tables.filter((t) => t.owned).map((t) => t.table),
    },
    tables,
    failures,
    exitCode: failures.length === 0 ? 0 : 1,
  };
}

export function formatReport(report) {
  if (!report.reachable) {
    return `RLS check\n\nFAIL — cannot inspect the database: ${report.error}\n`;
  }

  const width = Math.max(...report.tables.map((t) => t.table.length));
  const lines = ['RLS check', ''];
  lines.push(`role: ${report.role.name}`);
  lines.push(`  rolbypassrls: ${report.role.bypassRls}`);
  lines.push(
    `  owns: ${report.role.ownedTables.length === 0 ? '(no listed table)' : report.role.ownedTables.join(', ')}`,
  );
  lines.push('');
  lines.push(`tables (policy = ${report.policyName}):`);
  for (const t of report.tables) {
    const state = t.present
      ? `rls=${onOff(t.rls)}  force=${onOff(t.force)}  policy=${t.policy ? 'present' : 'missing'}`
      : 'missing from the database';
    const expect = t.expected === null ? '' : `  expected=${t.expected ? 'on' : 'off'}`;
    lines.push(`  ${t.table.padEnd(width)}  ${t.scope.padEnd(11)}  ${state}${expect}`);
  }
  lines.push('');

  if (report.expectation === null) {
    lines.push('Report only. Pass --expect <state> to turn it into a pass/fail check.');
  } else if (report.failures.length === 0) {
    lines.push(`PASS — the database matches --expect ${report.expectation}.`);
  } else {
    lines.push(`FAIL — the database differs from --expect ${report.expectation}:`);
    for (const failure of report.failures) lines.push(`  - ${failure}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function main(
  argv,
  {
    env = process.env,
    readFile,
    loadLists = loadRlsTables,
    observe = observeRls,
    write = (s) => process.stdout.write(s),
  } = {},
) {
  let expectation;
  try {
    ({ expectation } = parseArgs(argv));
  } catch (error) {
    write(`${error.message}\n`);
    return 1;
  }

  const lists = await loadLists();
  const { url, source } = resolveDatabaseUrl(readFile ? { env, readFile } : { env });
  const observation = await observe(url, lists);
  const report = buildReport({ lists, observation, expectation });

  write(formatReport(report));
  if (source) write(`  database url read from ${source}\n`);
  return report.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error('RLS check failed:', error.message);
      process.exitCode = 1;
    });
}
