// Dependency audit gate — tests.
//
// Fixtures are literals, shaped like the `pnpm audit --json` payload pnpm 9
// emits: an `advisories` object keyed by the numeric advisory id, each entry
// carrying `github_advisory_id`, `module_name`, `severity` and `findings`.
// The expectations are written by hand so the test cannot pass by repeating the
// comparison the gate uses.

import { describe, expect, it } from 'vitest';

import { checkAudit, formatReport, isTransientFailure, runAuditWithRetries } from './check-audit.mjs';

const NOW = new Date('2026-10-20T00:00:00Z');

const advisory = (id, pkg, severity = 'high', paths = [`root > chain > ${pkg}@1.0.0`]) => ({
  id: 1,
  github_advisory_id: id,
  module_name: pkg,
  severity,
  findings: [{ version: '1.0.0', paths }],
});

const report = (advisories) => ({
  actions: [],
  advisories: Object.fromEntries(advisories.map((entry, index) => [String(index + 1), entry])),
  metadata: { vulnerabilities: { high: advisories.length } },
});

const allowlistEntry = (overrides = {}) => ({
  id: 'GHSA-aaaa-bbbb-cccc',
  package: 'braces',
  path: 'root > chain > braces@1.0.0',
  reason: 'Build-time only; no patched version.',
  acceptedBy: 'juancodedev',
  expires: '2027-01-31',
  ...overrides,
});

const run = (overrides = {}) =>
  checkAudit({
    report: report([advisory('GHSA-aaaa-bbbb-cccc', 'braces')]),
    allowlist: [allowlistEntry()],
    now: NOW,
    ...overrides,
  });

describe('checkAudit', () => {
  it('fails an unallowlisted high advisory and names it', () => {
    const result = run({ allowlist: [] });

    expect(result.exitCode).toBe(1);
    expect(result.unallowed).toHaveLength(1);
    expect(result.unallowed[0]).toMatchObject({ id: 'GHSA-aaaa-bbbb-cccc', package: 'braces' });
  });

  it('passes an allowlisted high advisory', () => {
    expect(run().exitCode).toBe(0);
    expect(run().allowed).toHaveLength(1);
  });

  it('fails an allowlist entry past its expiry', () => {
    const result = run({ allowlist: [allowlistEntry({ expires: '2026-10-19' })] });

    expect(result.exitCode).toBe(1);
    expect(result.expired).toHaveLength(1);
  });

  it('fails a second advisory id in an allowlisted package', () => {
    const result = run({
      report: report([
        advisory('GHSA-aaaa-bbbb-cccc', 'braces'),
        advisory('GHSA-dddd-eeee-ffff', 'braces'),
      ]),
    });

    expect(result.exitCode).toBe(1);
    expect(result.unallowed).toHaveLength(1);
    expect(result.unallowed[0].id).toBe('GHSA-dddd-eeee-ffff');
  });

  it('passes a moderate advisory and reports it', () => {
    const result = run({
      report: report([advisory('GHSA-aaaa-bbbb-cccc', 'braces', 'moderate')]),
      allowlist: [],
    });

    expect(result.exitCode).toBe(0);
    expect(result.moderate).toHaveLength(1);
  });

  it('fails on a registry error instead of passing', () => {
    const result = checkAudit({
      report: { error: { code: 'EAI_AGAIN', summary: 'registry unavailable' } },
      allowlist: [],
      now: NOW,
    });

    expect(result.exitCode).toBe(1);
    expect(result.blockedReason).toMatch(/registry/i);
  });

  it('reports a stale allowlist entry without failing', () => {
    const result = run({
      report: report([]),
      allowlist: [allowlistEntry()],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stale).toHaveLength(1);
  });

  it('fails an allowlist entry missing a required field', () => {
    const result = run({ allowlist: [allowlistEntry({ acceptedBy: '' })] });

    expect(result.exitCode).toBe(1);
    expect(result.invalid).toHaveLength(1);
  });

  it('fails a critical advisory that is not allowlisted', () => {
    const result = run({
      report: report([advisory('GHSA-aaaa-bbbb-cccc', 'braces', 'critical')]),
      allowlist: [],
    });

    expect(result.exitCode).toBe(1);
    expect(result.unallowed[0].severity).toBe('critical');
  });
});

describe('formatReport', () => {
  it('prints the allowed and stale counts on a pass', () => {
    const text = formatReport(run({ report: report([]), allowlist: [allowlistEntry()] }));

    expect(text).toContain('PASS');
    expect(text).toContain('stale');
  });

  it('prints each unallowlisted advisory with its package and id', () => {
    const text = formatReport(run({ allowlist: [] }));

    expect(text).toContain('BLOCKED');
    expect(text).toContain('braces');
    expect(text).toContain('GHSA-aaaa-bbbb-cccc');
  });
});

// What the retry must and must not swallow. The `pnpm audit` payload for a
// socket timeout is JSON with an `error` object, not empty output — that shape
// is the one CI actually produced.
describe('isTransientFailure', () => {
  it('treats a socket timeout in the payload as transient', () => {
    expect(
      isTransientFailure({
        stdout: JSON.stringify({ error: { code: 'ERR_SOCKET_TIMEOUT', summary: 'request timed out' } }),
        stderr: '',
      }),
    ).toBe(true);
  });

  it('treats a spawn timeout as transient', () => {
    expect(isTransientFailure({ error: { code: 'ETIMEDOUT' } })).toBe(true);
  });

  it('treats a socket error on stderr as transient', () => {
    expect(isTransientFailure({ stdout: '', stderr: 'request to registry failed: socket hang up' })).toBe(true);
  });

  it('does not retry a payload that carries advisories', () => {
    // `pnpm audit` exits 1 when it finds something. That is an answer, and
    // retrying it would only delay the failure.
    expect(isTransientFailure({ stdout: JSON.stringify(report([advisory('GHSA-aaaa-bbbb-cccc', 'braces')])) })).toBe(
      false,
    );
  });

  it('does not retry an error that is not the network', () => {
    expect(isTransientFailure({ stdout: JSON.stringify({ error: { code: 'E404', summary: 'not found' } }) })).toBe(
      false,
    );
    expect(isTransientFailure({ stdout: 'not json', stderr: 'ELIFECYCLE command failed' })).toBe(false);
  });

  it('does not invent a retry out of silence', () => {
    expect(isTransientFailure({ stdout: '', stderr: '' })).toBe(false);
  });
});

describe('runAuditWithRetries', () => {
  const timeoutPayload = { stdout: JSON.stringify({ error: { code: 'ERR_SOCKET_TIMEOUT' } }), stderr: '' };
  const goodPayload = { stdout: JSON.stringify(report([])), stderr: '' };

  it('retries a transport failure and returns the answer it eventually got', () => {
    const queue = [timeoutPayload, goodPayload];
    const sleeps = [];
    const retries = [];

    const outcome = runAuditWithRetries({
      runAudit: () => queue.shift(),
      sleep: (ms) => sleeps.push(ms),
      onRetry: (info) => retries.push(info),
    });

    expect(outcome.attempts).toBe(2);
    expect(outcome.audit).toBe(goodPayload);
    expect(sleeps).toEqual([2_000]);
    expect(retries[0].detail).toBe('ERR_SOCKET_TIMEOUT');
  });

  it('stops at the attempt budget and returns the failure to block on', () => {
    const sleeps = [];
    const outcome = runAuditWithRetries({
      runAudit: () => timeoutPayload,
      sleep: (ms) => sleeps.push(ms),
      attempts: 3,
    });

    expect(outcome.attempts).toBe(3);
    expect(outcome.audit).toBe(timeoutPayload);
    expect(sleeps).toEqual([2_000, 8_000]);
  });

  it('does not retry a report that already has advisories', () => {
    let calls = 0;
    const outcome = runAuditWithRetries({
      runAudit: () => {
        calls += 1;
        return { stdout: JSON.stringify(report([advisory('GHSA-aaaa-bbbb-cccc', 'braces')])), stderr: '' };
      },
      sleep: () => {
        throw new Error('should not sleep');
      },
    });

    expect(calls).toBe(1);
    expect(outcome.attempts).toBe(1);
  });
});
