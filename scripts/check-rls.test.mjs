// The RLS verification script is the exit criterion of every rollout phase, so
// these tests pin what it may call a pass: the expected state per phase, a
// missing policy, a missing table, and the refusal of a session that is not
// read-only. Everything runs against fixture catalog rows; nothing connects.
//
// Development tool test: kept beside the script it covers, outside `src`, so it
// is neither linted nor typechecked as product code.
import { describe, expect, it } from 'vitest';

import { BUSINESS_ID_TABLES, RLS_POLICY_NAME, TENANT_ID_TABLES } from '../packages/db/src/rls.ts';
import {
  EXPECTATIONS,
  RLS_BATCHES,
  buildReport,
  expectedEnabled,
  formatReport,
  loadRlsTables,
  main,
  observeRls,
  parseArgs,
} from './check-rls.mjs';

const LISTS = {
  businessIdTables: [...BUSINESS_ID_TABLES],
  tenantIdTables: [...TENANT_ID_TABLES],
  policyName: RLS_POLICY_NAME,
};

const OWNER = 'neondb_owner';
const URL = 'postgresql://u:secret@ep-test.neon.tech/db?sslmode=verify-full';

/** One observation whose listed tables are enabled (with policy) exactly when `enabled` has them. */
function observation(enabled, { role = OWNER, bypassRls = true, owner = OWNER, omit = [] } = {}) {
  const all = [...LISTS.businessIdTables, ...LISTS.tenantIdTables].filter((t) => !omit.includes(t));
  return {
    reachable: true,
    role: { name: role, bypassRls },
    tables: all.map((relname) => ({
      relname,
      relrowsecurity: enabled.has(relname),
      relforcerowsecurity: false,
      owner,
    })),
    policies: all.filter((t) => enabled.has(t)),
  };
}

/** A pool that answers the catalog queries from fixture rows and records every statement. */
function fakePool({
  readOnly = 'on',
  role = OWNER,
  bypass = true,
  tables = [],
  policies = [],
} = {}) {
  const statements = [];
  let ended = false;
  return {
    statements,
    get ended() {
      return ended;
    },
    async query(text) {
      statements.push(text);
      if (/^SET default_transaction_read_only/.test(text)) return { rows: [] };
      if (/^SHOW default_transaction_read_only/.test(text)) {
        return { rows: [{ default_transaction_read_only: readOnly }] };
      }
      if (/from pg_roles/.test(text)) return { rows: [{ role, rolbypassrls: bypass }] };
      if (/from pg_class/.test(text)) return { rows: tables };
      if (/from pg_policies/.test(text))
        return { rows: policies.map((tablename) => ({ tablename })) };
      throw new Error(`unexpected query: ${text}`);
    },
    async end() {
      ended = true;
    },
  };
}

/** The production state after migration 0026: every table the wallet phase enables. */
const WALLET_PHASE = new Set([...TENANT_ID_TABLES, ...RLS_BATCHES.wallet]);

describe('the table lists', () => {
  it('are read from packages/db/src/rls.ts, not copied', async () => {
    const loaded = await loadRlsTables();
    expect(loaded).toEqual(LISTS);
  });

  it('batches name only business tables, and `rest` is every business table left', () => {
    const named = [...RLS_BATCHES.wallet, ...RLS_BATCHES.communication, ...RLS_BATCHES.growth];
    for (const table of named) expect(LISTS.businessIdTables).toContain(table);

    const rest = expectedEnabled('rest', LISTS);
    expect(rest).toEqual(expectedEnabled('all', LISTS));
  });
});

describe('parseArgs', () => {
  it('reads `--expect <state>`, `--expect=<state>` and ignores the `--` pnpm passes on', () => {
    expect(parseArgs([])).toEqual({ expectation: null });
    expect(parseArgs(['--', '--expect', 'wallet'])).toEqual({ expectation: 'wallet' });
    expect(parseArgs(['--expect=growth'])).toEqual({ expectation: 'growth' });
  });

  it('refuses an unknown state or a missing value', () => {
    expect(() => parseArgs(['--expect', 'wallets'])).toThrow(
      /none\|wallet\|communication\|growth\|rest\|all/,
    );
    expect(() => parseArgs(['--expect'])).toThrow(/--expect/);
    expect(() => parseArgs(['--verbose'])).toThrow(/--verbose/);
  });

  it('accepts exactly none, wallet, all and the three batches', () => {
    expect(EXPECTATIONS).toEqual(['none', 'wallet', 'communication', 'growth', 'rest', 'all']);
  });
});

describe('expectedEnabled', () => {
  it('is cumulative: each phase keeps every earlier phase enabled', () => {
    expect(expectedEnabled('none', LISTS)).toEqual(new Set());
    expect(expectedEnabled('wallet', LISTS)).toEqual(
      new Set([...LISTS.tenantIdTables, 'push_campaigns']),
    );
    expect(expectedEnabled('communication', LISTS)).toEqual(
      new Set([
        ...LISTS.tenantIdTables,
        'push_campaigns',
        'message_log',
        'whatsapp_templates',
        'push_subscriptions',
      ]),
    );
    const growth = expectedEnabled('growth', LISTS);
    for (const table of [
      ...LISTS.tenantIdTables,
      ...RLS_BATCHES.communication,
      ...RLS_BATCHES.growth,
    ]) {
      expect(growth.has(table)).toBe(true);
    }
    expect(growth.has('customers')).toBe(false);
    expect(expectedEnabled('all', LISTS)).toEqual(
      new Set([...LISTS.businessIdTables, ...LISTS.tenantIdTables]),
    );
  });
});

describe('buildReport', () => {
  it('`--expect wallet` covers push_campaigns, which was enabled before the rollout', () => {
    const walletOnly = buildReport({
      lists: LISTS,
      observation: observation(new Set(TENANT_ID_TABLES)),
      expectation: 'wallet',
    });
    expect(walletOnly.exitCode).toBe(1);
    expect(formatReport(walletOnly)).toContain('push_campaigns: expected RLS on');

    const production = buildReport({
      lists: LISTS,
      observation: observation(new Set([...TENANT_ID_TABLES, 'push_campaigns'])),
      expectation: 'wallet',
    });
    expect(production.failures).toEqual([]);
  });

  it('reports every listed table, the role, its bypass and the tables it owns, and exits 0 without an expectation', () => {
    const report = buildReport({
      lists: LISTS,
      observation: observation(new Set()),
      expectation: null,
    });

    expect(report.tables.map((t) => t.table)).toEqual([
      ...LISTS.businessIdTables,
      ...LISTS.tenantIdTables,
    ]);
    expect(report.tables[0]).toMatchObject({
      scope: 'business_id',
      rls: false,
      force: false,
      policy: false,
    });
    expect(report.role).toEqual({
      name: OWNER,
      bypassRls: true,
      ownedTables: [...LISTS.businessIdTables, ...LISTS.tenantIdTables],
    });
    expect(report.exitCode).toBe(0);

    const text = formatReport(report);
    expect(text).toContain(`role: ${OWNER}`);
    expect(text).toContain('rolbypassrls: true');
    expect(text).toMatch(/customers\s+business_id\s+rls=off\s+force=off\s+policy=missing/);
  });

  it('reports a role that owns nothing and lacks BYPASSRLS', () => {
    const report = buildReport({
      lists: LISTS,
      observation: observation(new Set(), { role: 'vyloop_app', bypassRls: false }),
      expectation: null,
    });
    expect(report.role).toEqual({ name: 'vyloop_app', bypassRls: false, ownedTables: [] });
    expect(formatReport(report)).toContain('owns: (no listed table)');
  });

  it.each([
    ['none', new Set()],
    ['wallet', new Set([...TENANT_ID_TABLES, ...RLS_BATCHES.wallet])],
    [
      'communication',
      new Set([...TENANT_ID_TABLES, ...RLS_BATCHES.wallet, ...RLS_BATCHES.communication]),
    ],
    [
      'growth',
      new Set([
        ...TENANT_ID_TABLES,
        ...RLS_BATCHES.wallet,
        ...RLS_BATCHES.communication,
        ...RLS_BATCHES.growth,
      ]),
    ],
    ['rest', new Set([...TENANT_ID_TABLES, ...BUSINESS_ID_TABLES])],
    ['all', new Set([...TENANT_ID_TABLES, ...BUSINESS_ID_TABLES])],
  ])('passes `--expect %s` when the database matches it', (expectation, enabled) => {
    const report = buildReport({ lists: LISTS, observation: observation(enabled), expectation });
    expect(report.failures).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(formatReport(report)).toContain(`PASS — the database matches --expect ${expectation}`);
  });

  it.each(['none', 'communication', 'growth', 'rest', 'all'])(
    'fails `--expect %s` against a database in the wallet phase',
    (expectation) => {
      const report = buildReport({
        lists: LISTS,
        observation: observation(WALLET_PHASE),
        expectation,
      });
      expect(report.exitCode).toBe(1);
      expect(report.failures.length).toBeGreaterThan(0);
      expect(formatReport(report)).toContain(
        `FAIL — the database differs from --expect ${expectation}`,
      );
    },
  );

  it('lists the wallet tables as enabled and the business tables as not, under `--expect wallet`', () => {
    const report = buildReport({
      lists: LISTS,
      observation: observation(WALLET_PHASE),
      expectation: 'wallet',
    });
    const text = formatReport(report);
    expect(text).toMatch(
      /customer_wallet_passes\s+tenant_id\s+rls=on\s+force=off\s+policy=present/,
    );
    expect(text).toMatch(/customers\s+business_id\s+rls=off\s+force=off\s+policy=missing/);
    expect(report.exitCode).toBe(0);
  });

  it('fails and names a table whose RLS is on but whose policy is missing', () => {
    const obs = observation(WALLET_PHASE);
    obs.policies = obs.policies.filter((t) => t !== 'customer_wallet_passes');

    const report = buildReport({ lists: LISTS, observation: obs, expectation: 'wallet' });
    expect(report.exitCode).toBe(1);
    expect(report.failures).toEqual([
      `customer_wallet_passes: expected RLS on with the ${RLS_POLICY_NAME} policy, found rls=on, policy=missing`,
    ]);
    expect(formatReport(report)).toContain('customer_wallet_passes: expected RLS on');
  });

  it('fails a table expected off that still carries a policy', () => {
    const obs = observation(new Set());
    obs.policies = ['customers'];
    const report = buildReport({ lists: LISTS, observation: obs, expectation: 'none' });
    expect(report.failures).toEqual([
      `customers: expected RLS off and no ${RLS_POLICY_NAME} policy, found rls=off, policy=present`,
    ]);
    expect(report.exitCode).toBe(1);
  });

  it('fails a listed table that does not exist in the database', () => {
    const report = buildReport({
      lists: LISTS,
      observation: observation(new Set(), { omit: ['checkins'] }),
      expectation: 'none',
    });
    expect(report.failures).toEqual(['checkins: listed in rls.ts but missing from the database']);
    expect(report.exitCode).toBe(1);
  });

  it('fails when the database could not be inspected, with or without an expectation', () => {
    for (const expectation of [null, 'none', 'all']) {
      const report = buildReport({
        lists: LISTS,
        observation: { reachable: false, error: 'connect ECONNREFUSED' },
        expectation,
      });
      expect(report.exitCode).toBe(1);
      expect(formatReport(report)).toContain(
        'FAIL — cannot inspect the database: connect ECONNREFUSED',
      );
    }
  });
});

describe('observeRls', () => {
  it('reads the catalog only after the session is confirmed read-only', async () => {
    const pool = fakePool({
      tables: [
        { relname: 'customers', relrowsecurity: true, relforcerowsecurity: true, owner: OWNER },
      ],
      policies: ['customers'],
    });
    const result = await observeRls(URL, LISTS, { createPool: () => pool });

    expect(pool.statements[0]).toBe('SET default_transaction_read_only = on');
    expect(pool.statements[1]).toBe('SHOW default_transaction_read_only');
    expect(result).toEqual({
      reachable: true,
      role: { name: OWNER, bypassRls: true },
      tables: [
        { relname: 'customers', relrowsecurity: true, relforcerowsecurity: true, owner: OWNER },
      ],
      policies: ['customers'],
    });
    expect(pool.ended).toBe(true);
  });

  it('refuses a writable session and reads nothing', async () => {
    const pool = fakePool({ readOnly: 'off' });
    const result = await observeRls(URL, LISTS, { createPool: () => pool });

    expect(result).toEqual({
      reachable: false,
      error: 'the database did not honour a read-only session; refusing to continue',
    });
    expect(pool.statements).toEqual([
      'SET default_transaction_read_only = on',
      'SHOW default_transaction_read_only',
    ]);
    expect(pool.ended).toBe(true);
  });

  it('refuses a URL without sslmode=verify-full before connecting', async () => {
    let created = false;
    await expect(
      observeRls('postgresql://u:secret@ep-test.neon.tech/db', LISTS, {
        createPool: () => {
          created = true;
          return fakePool();
        },
      }),
    ).rejects.toThrow(/sslmode must be verify-full/);
    expect(created).toBe(false);
  });
});

describe('main', () => {
  function run(argv, observe) {
    const out = [];
    return main(argv, {
      env: { DATABASE_URL: URL },
      loadLists: async () => LISTS,
      observe,
      write: (s) => out.push(s),
    }).then((code) => ({ code, out: out.join('') }));
  }

  it('exits 1 when the session is writable, whatever the expectation', async () => {
    const { code, out } = await run(['--expect', 'none'], (url, lists) =>
      observeRls(url, lists, { createPool: () => fakePool({ readOnly: 'off' }) }),
    );
    expect(code).toBe(1);
    expect(out).toContain('did not honour a read-only session');
  });

  it('exits 0 for a matching expectation and 1 for a differing one', async () => {
    const walletPhase = async () => observation(WALLET_PHASE);
    expect((await run(['--expect', 'wallet'], walletPhase)).code).toBe(0);
    expect((await run(['--expect', 'all'], walletPhase)).code).toBe(1);
  });

  it('exits 1 on a bad argument without connecting', async () => {
    let observed = false;
    const { code, out } = await run(['--expect', 'everything'], async () => {
      observed = true;
      return observation(new Set());
    });
    expect(code).toBe(1);
    expect(observed).toBe(false);
    expect(out).toContain('--expect');
  });

  it('exits 1 when DATABASE_URL is missing', async () => {
    const out = [];
    const code = await main([], {
      env: {},
      readFile: () => {
        throw new Error('ENOENT');
      },
      loadLists: async () => LISTS,
      write: (s) => out.push(s),
    });
    expect(code).toBe(1);
    expect(out.join('')).toContain('DATABASE_URL is not set');
  });
});
