// The readiness report is only worth having if it is honest. These tests pin the
// behaviour that makes it so: an unknown is never a pass, and the blocking gates
// come out in the order a request hits them.
//
// Development tool test: kept beside the script it covers, outside `src`, so it
// is neither linted nor typechecked as product code.
import { describe, expect, it } from 'vitest';

import {
  buildGates,
  formatReport,
  missingSecrets,
  REQUIRED_SECRETS,
  verdict,
} from './check-wallet-readiness.mjs';

const HEALTHY = {
  deployedSecrets: [...REQUIRED_SECRETS],
  canSeeSecrets: true,
  migrationApplied: true,
  canSeeDatabase: true,
  reviewStatus: 'approved',
  programCount: 1,
  demoMode: false,
  databaseLabel: 'neondb',
  gatewayReachable: true,
};

function firstBlocker(overrides) {
  return verdict(buildGates({ ...HEALTHY, ...overrides })).blocked[0]?.id;
}

describe('buildGates', () => {
  it('orders the gates the way a request hits them', () => {
    const ids = buildGates(HEALTHY).map((gate) => gate.id);
    expect(ids).toEqual(['database', 'secrets', 'class', 'demo-mode', 'gateway']);
  });

  it('passes every gate when the deployment is genuinely ready', () => {
    expect(verdict(buildGates(HEALTHY)).blocked).toEqual([]);
  });

  it('names which secret is missing, not just that one is', () => {
    const gates = buildGates({ ...HEALTHY, deployedSecrets: ['MEMBER_CODE_PEPPER'] });
    const secrets = gates.find((gate) => gate.id === 'secrets');
    expect(secrets.pass).toBe(false);
    expect(secrets.blocked).toContain('GOOGLE_WALLET_PRIVATE_KEY');
    expect(secrets.blocked).toContain('GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL');
    expect(secrets.blocked).not.toContain('MEMBER_CODE_PEPPER');
  });

  it('blocks a class Google has not approved, whatever the state is called', () => {
    // "approved" is the only value that passes. A status the code does not
    // recognise must not be treated as a near-miss.
    for (const status of ['draft', 'pending', 'in_review', 'APPROVED', 'approved ']) {
      expect(firstBlocker({ reviewStatus: status })).toBe('class');
    }
  });

  it('blocks a missing class row separately from an unapproved one', () => {
    // Both block, but they are different problems with different fixes, so the
    // wording has to tell them apart.
    const missing = buildGates({ ...HEALTHY, programCount: 0, reviewStatus: null });
    const unapproved = buildGates({ ...HEALTHY, programCount: 1, reviewStatus: 'draft' });

    expect(missing.find((gate) => gate.id === 'class').pass).toBe(false);
    expect(missing.find((gate) => gate.id === 'class').blocked).toContain('no pass class row');
    expect(missing.find((gate) => gate.id === 'class').next).toContain('tenant_wallet_programs');

    expect(unapproved.find((gate) => gate.id === 'class').pass).toBe(false);
    expect(unapproved.find((gate) => gate.id === 'class').blocked).toContain('"draft"');
    expect(unapproved.find((gate) => gate.id === 'class').next).toContain('cannot be skipped');
  });

  it('reads the demo-mode switch as a boolean, not a config string', () => {
    // The gate reads the effective value, which is boolean: a row that is in demo
    // mode is a state, not a failure, so it must not be reported as a blocker.
    expect(buildGates(HEALTHY).find((g) => g.id === 'demo-mode').pass).toBe(true);
    expect(buildGates({ ...HEALTHY, demoMode: true }).find((g) => g.id === 'demo-mode').pass).toBe(false);
  });

  it('names the database it read, because the deployed worker uses another one', () => {
    // A report that reads dev-local and implies production is how a correctly
    // configured deployment reads as broken.
    expect(formatReport(buildGates(HEALTHY))).toContain('neondb');
  });
});

describe('verdict', () => {
  it('never treats an unobservable fact as readiness', () => {
    // The failure mode this exists to prevent: a check that could not run
    // reporting "ready" because nothing looked wrong.
    const { ready, unknown } = verdict(
      buildGates({ ...HEALTHY, canSeeSecrets: false, deployedSecrets: [] }),
    );
    expect(ready).toBeNull();
    expect(unknown.map((gate) => gate.id)).toEqual(['secrets']);
  });

  it('reports unknown when the class cannot be observed at all', () => {
    // Unreachable database means no status was read, so `reviewStatus` is null
    // rather than some value that happens to look fine. Both the table check and
    // the class check then rest on nothing and say so.
    const { ready, unknown } = verdict(
      buildGates({ ...HEALTHY, canSeeDatabase: false, reviewStatus: null, programCount: 0 }),
    );
    expect(ready).toBeNull();
    // The demo-mode switch is a column, so an unreadable database takes it with it.
    expect(unknown.map((gate) => gate.id)).toEqual(['database', 'class', 'demo-mode']);
  });

  it('does not report the class as blocked just because the database was unreachable', () => {
    // The distinction that matters: "Google has not approved it" and "I could not
    // find out" call for different actions, and conflating them sends someone to
    // re-apply a migration that is already there.
    const gates = buildGates({ ...HEALTHY, canSeeDatabase: false, reviewStatus: null, programCount: 0 });
    const cls = gates.find((gate) => gate.id === 'class');
    expect(cls.pass).toBeNull();
    expect(cls.pass).not.toBe(false);
  });

  it('is not ready when anything is blocked, even if other checks are unknown', () => {
    const { ready } = verdict(
      buildGates({ ...HEALTHY, canSeeSecrets: false, reviewStatus: 'draft' }),
    );
    expect(ready).toBe(false);
  });
});

describe('formatReport', () => {
  it('marks a passing gate PASS and a blocking one BLOCK', () => {
    const report = formatReport(buildGates({ ...HEALTHY, reviewStatus: 'draft', demoMode: true }));
    expect(report).toContain('[PASS] Wallet tables exist');
    expect(report).toContain('[BLOCK] Google approved the pass class');
    expect(report).toContain('NOT READY');
  });

  it('marks an unobservable gate as unknown rather than as a pass', () => {
    const report = formatReport(buildGates({ ...HEALTHY, canSeeSecrets: false }));
    expect(report).toContain('[????] Signing secrets on the deployed worker');
    expect(report).not.toContain('[PASS] Signing secrets on the deployed worker');
    expect(report).toContain('UNKNOWN');
  });

  it('never states a blocking fact for an unknown gate', () => {
    // The exact wording that misleads: an unreachable database reported as "the
    // tables are not there", and a secrets check that could not run reported as
    // a list of names that are missing.
    const report = formatReport(
      buildGates({
        ...HEALTHY,
        canSeeSecrets: false,
        canSeeDatabase: false,
        reviewStatus: null,
      }),
    );
    expect(report).toContain('could not be checked from here');
    expect(report).not.toContain('The wallet tables are not in this database');
    expect(report).not.toContain('no pass class row');
    expect(report).not.toContain('Missing:');
  });

  it('shows a next action for every blocker', () => {
    const report = formatReport(buildGates({ ...HEALTHY, deployedSecrets: [], demoMode: 'true' }));
    const blockers = report.split('\n').filter((line) => line.includes('next:'));
    expect(blockers.length).toBe(2);
  });
});

describe('missingSecrets', () => {
  it('reports only what is absent', () => {
    expect(missingSecrets(REQUIRED_SECRETS)).toEqual([]);
    expect(missingSecrets([])).toEqual(REQUIRED_SECRETS);
  });
});
