import { describe, expect, it, vi } from 'vitest';

import {
  EXIT_NO_DATABASE_URL,
  EXIT_OK,
  EXIT_USAGE,
  USAGE,
  main,
  narrowPlanTo,
  parseArgs,
  renderPlan,
} from './pass-inactivity-dry-run.mjs';

/**
 * The pass-inactivity dry run.
 *
 * ## What is under test and what deliberately is not
 *
 * The pure parts: argument parsing, the text report, and narrowing a plan to one
 * tenant. The database access is **not** under test — it is a real connection to
 * a real database, which this suite does not have and which running would mean
 * writing to something.
 *
 * ## The guards worth the trouble
 *
 * This script is the thing an operator runs *before* the run that moves real
 * customers' cards. So the properties that matter are mostly about what it cannot
 * do:
 *
 *   - it has no flag that writes, and adding one is a different tool;
 *   - it cannot reach Google, because the function it imports takes no client;
 *   - it reports the number the **write path** uses, not a recount of its own
 *     printed lines;
 *   - and a tenant scoped by uuid cannot widen into another tenant's rows.
 */

const TENANT_A = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const TENANT_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CUTOFF = new Date('2026-07-05T06:00:00.000Z');

function candidate(n, lastActivityAt) {
  return {
    customerId: `d185c973-c976-46b5-b3bf-${String(n).padStart(12, '0')}`,
    objectId: `3388000000023206930.member-customer-${n}`,
    lastActivityAt,
  };
}

function plan(overrides = {}) {
  return {
    tenantsConsidered: 2,
    tenantsConfigured: 1,
    tenantsDisabled: 1,
    tenants: [
      {
        tenantId: TENANT_A,
        months: 3,
        cutoff: CUTOFF,
        candidates: [candidate(1, new Date('2025-02-01T00:00:00.000Z')), candidate(2, null)],
        truncated: false,
      },
    ],
    totalCandidates: 2,
    tenantsTruncated: 0,
    ...overrides,
  };
}

function sink() {
  return { log: vi.fn(), error: vi.fn() };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('defaults to every tenant and the text report', () => {
    const result = parseArgs([]);
    expect(result).toEqual({ ok: true, options: { tenantId: null, json: false, help: false } });
  });

  it('accepts a tenant id', () => {
    const result = parseArgs(['--tenant', TENANT_A]);
    expect(result).toEqual({
      ok: true,
      options: { tenantId: TENANT_A, json: false, help: false },
    });
  });

  it('rejects a tenant id that is not a uuid', () => {
    // The value is bound as `::uuid` in the query that scopes the whole rule. A
    // typo must fail here rather than be cast to NULL and quietly match no rows —
    // a report that says "no candidates" because of a typo is the most dangerous
    // thing this tool can print.
    const result = parseArgs(['--tenant', 'not-a-uuid']);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a tenant id/i);
  });

  it('rejects --tenant with nothing after it', () => {
    expect(parseArgs(['--tenant']).ok).toBe(false);
    expect(parseArgs(['--tenant', '--json']).ok).toBe(false);
  });

  it('has no flag that writes, and says so when asked for one', () => {
    // The load-bearing assertion of this block. A read-only tool that grew an
    // --apply is the change that should require writing a new tool.
    for (const flag of ['--apply', '--execute', '--write', '--run', '--force']) {
      const result = parseArgs([flag]);
      expect(result.ok, `${flag} was accepted`).toBe(false);
      expect(result.reason).toContain('takes no flag that writes');
    }
  });

  it('rejects an unknown argument rather than ignoring it', () => {
    const result = parseArgs(['--tenant=abc']);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Unknown argument/);
  });

  it('accepts --help and --json', () => {
    expect(parseArgs(['--help']).options.help).toBe(true);
    expect(parseArgs(['-h']).options.help).toBe(true);
    expect(parseArgs(['--json']).options.json).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderPlan
// ---------------------------------------------------------------------------

describe('renderPlan', () => {
  it('prints the count the plan computed, not a recount of its own lines', () => {
    const output = renderPlan(plan());

    // The tenant header, the total, and the two listed candidates must agree.
    expect(output).toContain(`Tenant ${TENANT_A} — window 3 month(s)`);
    expect(output).toContain('2 pass(es) would be deactivated');
    expect(output).toContain('Total: 2 pass(es) across 1 configured tenant(s).');
    expect(output.match(/d185c973-c976-46b5-b3bf-00000000000[12]/g)).toHaveLength(2);
  });

  it('prints the cutoff, because "why is this customer in the list" needs it', () => {
    expect(renderPlan(plan())).toContain(CUTOFF.toISOString());
  });

  it('says why a customer with no transactions is listed', () => {
    // Otherwise the row is unexplained and an operator has to go write the query
    // themselves — which is the thing this tool exists to save them from.
    const output = renderPlan(plan());
    expect(output).toContain('never transacted');
    expect(output).toContain('clocked from enrolment');
  });

  it('says what a customer\'s last activity was', () => {
    expect(renderPlan(plan())).toContain('2025-02-01T00:00:00.000Z');
  });

  it('announces truncation instead of printing a floor as a total', () => {
    // The one way this report could cause a decision it should not support.
    const output = renderPlan(
      plan({ tenantsTruncated: 1, tenants: [{ ...plan().tenants[0], truncated: true }] }),
    );

    expect(output).toContain('TRUNCATED');
    expect(output).toContain('lower bound');
  });

  it('explains an empty result as "not opted in", not as "nothing to do"', () => {
    // The distinction is the whole reason the column has no default. A tenant whose
    // window is NULL is a tenant that never asked for this, and a report that
    // could not tell those apart would make opt-in look broken.
    const output = renderPlan(
      plan({ tenantsConsidered: 7, tenantsConfigured: 0, tenantsDisabled: 7, tenants: [], totalCandidates: 0 }),
    );

    expect(output).toContain('No tenant has this rule enabled');
    expect(output).toContain('NULL');
    expect(output).toContain('pass_inactivity_months');
  });

  it('points at the migration that explains why the obvious column is not used', () => {
    const output = renderPlan(
      plan({ tenantsConsidered: 1, tenantsConfigured: 0, tenantsDisabled: 1, tenants: [], totalCandidates: 0 }),
    );

    expect(output).toContain('0009_worried_onslaught.sql');
    expect(output).toContain('points_expiry_days');
  });

  it('reports the scope it ran with', () => {
    expect(renderPlan(plan(), { tenantId: null })).toContain('Scope: every tenant');
    expect(renderPlan(plan(), { tenantId: TENANT_A })).toContain(`Scope: ${TENANT_A}`);
  });

  it('says nothing was written', () => {
    expect(renderPlan(plan())).toMatch(/nothing was written/i);
  });

  it('handles a system with no wallet programs at all', () => {
    const output = renderPlan(
      plan({ tenantsConsidered: 0, tenantsConfigured: 0, tenantsDisabled: 0, tenants: [], totalCandidates: 0 }),
    );

    expect(output).toContain('No tenant with a Google Wallet program row');
  });
});

// ---------------------------------------------------------------------------
// narrowPlanTo
// ---------------------------------------------------------------------------

describe('narrowPlanTo', () => {
  const two = plan({
    tenantsConsidered: 2,
    tenants: [
      { tenantId: TENANT_A, months: 3, cutoff: CUTOFF, candidates: [candidate(1, null)], truncated: false },
      {
        tenantId: TENANT_B,
        months: 24,
        cutoff: new Date('2024-10-05T06:00:00.000Z'),
        candidates: [candidate(3, null), candidate(4, null), candidate(5, null)],
        truncated: false,
      },
    ],
    totalCandidates: 4,
  });

  it('keeps only the named tenant', () => {
    const narrowed = narrowPlanTo(two, TENANT_B);

    expect(narrowed.tenants.map((t) => t.tenantId)).toEqual([TENANT_B]);
    expect(narrowed.totalCandidates).toBe(3);
  });

  it('recomputes every counter, so no total can disagree with the rows shown', () => {
    // The mismatch this prevents: tenant A's candidates printed under tenant B's
    // totals, which reads as "these three passes" when it is these three plus A's.
    const narrowed = narrowPlanTo(two, TENANT_B);

    const listed = narrowed.tenants.reduce((sum, t) => sum + t.candidates.length, 0);
    expect(narrowed.totalCandidates).toBe(listed);
    expect(narrowed.tenantsConfigured).toBe(narrowed.tenants.length);
    expect(narrowed.tenantsConsidered).toBe(1);
  });

  it('reports a tenant with no window as unconfigured rather than absent', () => {
    const narrowed = narrowPlanTo(two, '00000000-0000-4000-8000-0000000000ff');

    expect(narrowed.tenants).toEqual([]);
    expect(narrowed.totalCandidates).toBe(0);
    expect(narrowed.tenantsConfigured).toBe(0);
    expect(narrowed.tenantsDisabled).toBe(1);
  });

  it('carries the tenant\'s own window and cutoff through untouched', () => {
    const narrowed = narrowPlanTo(two, TENANT_B);
    expect(narrowed.tenants[0].months).toBe(24);
    expect(narrowed.tenants[0].cutoff.toISOString()).toBe('2024-10-05T06:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

describe('main', () => {
  it('fails with a usage error and prints the help, without touching anything', async () => {
    const out = sink();
    const code = await main(['--apply'], {}, out);

    expect(code).toBe(EXIT_USAGE);
    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('takes no flag that writes'));
    expect(out.error).toHaveBeenCalledWith(USAGE);
  });

  it('prints the help and exits cleanly for --help, with no DATABASE_URL needed', async () => {
    const out = sink();
    const code = await main(['--help'], {}, out);

    expect(code).toBe(EXIT_OK);
    expect(out.log).toHaveBeenCalledWith(USAGE);
  });

  it('refuses to report without a DATABASE_URL rather than printing an empty plan', async () => {
    // A dry run that printed "nothing to do" because it could not connect is
    // indistinguishable from a tenant with no idle customers, and that is the one
    // answer here that most needs corroboration.
    const out = sink();
    const code = await main([], {}, out);

    expect(code).toBe(EXIT_NO_DATABASE_URL);
    expect(out.log).not.toHaveBeenCalled();
    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL is not set'));
  });

  it('asks for no Google credentials, and says why', () => {
    // The rule it reports on cannot call Google at all, so requiring Google
    // credentials to count its candidates would be a requirement with no meaning.
    expect(USAGE).toMatch(/no Google credentials/i);
  });
});
