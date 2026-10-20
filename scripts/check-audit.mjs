// Dependency advisory gate.
//
// Runs `pnpm audit --json` and fails on any `high` or `critical` advisory that
// is not covered by an entry in `scripts/audit-allowlist.json`. An allowlist
// entry records the decision GitHub's "dismiss" button records only in its UI:
// who accepted the risk, why, and until when. The expiry is the part that makes
// it a decision instead of a permanent mute.
//
// Three rules that are easy to get wrong, and are the reason this file exists
// instead of `pnpm audit --audit-level=high`:
//
//   1. **A registry error is a failure.** An audit that could not look is not an
//      audit that found nothing. Any non-JSON payload, an `error` object, or a
//      missing `advisories` map blocks.
//   2. **The match is advisory id + package.** Allowlisting `braces` for one
//      GHSA does not allow a second advisory in `braces`.
//   3. **Expired and stale are different.** An expired entry fails; a stale one
//      (no current advisory matches it) is reported and passes. Forcing a stale
//      entry out would make every dependency bump a red build.
//
// The pure functions are exported for `check-audit.test.mjs`; the CLI is the
// only part that touches the network. Like the other operational scripts, this
// one is run by `Test operational scripts` in CI, not by `pnpm -r test`.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ALLOWLIST_PATH = 'scripts/audit-allowlist.json';
const SEVERE = new Set(['high', 'critical']);
const REQUIRED_FIELDS = ['id', 'package', 'path', 'reason', 'acceptedBy', 'expires'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isoDate = (date) => date.toISOString().slice(0, 10);

/**
 * Parse the audit JSON without deciding anything.
 *
 * `pnpm audit` exits 1 when it finds a vulnerability, so the caller must not
 * treat a non-zero status as "no payload". The payload is the only signal.
 */
export function parseAuditReport(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`pnpm audit did not return JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('pnpm audit returned a non-object payload');
  }
  return parsed;
}

/** Validate the allowlist shape. Returns one message per unusable entry. */
export function validateAllowlist(entries) {
  if (!Array.isArray(entries)) {
    return ['the allowlist must be a JSON array'];
  }

  const errors = [];
  const seen = new Set();

  entries.forEach((entry, index) => {
    const where = `entry ${index + 1}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${where} is not an object`);
      return;
    }

    for (const field of REQUIRED_FIELDS) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        errors.push(`${where} is missing a non-empty "${field}"`);
      }
    }

    if (typeof entry.expires === 'string' && DATE.test(entry.expires)) {
      const parsed = new Date(`${entry.expires}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime())) {
        errors.push(`${where} has an invalid "expires" date`);
      }
    } else if (typeof entry.expires === 'string') {
      errors.push(`${where} has "expires" in a format other than YYYY-MM-DD`);
    }

    if (typeof entry.id === 'string' && typeof entry.package === 'string') {
      const key = `${entry.id}\u0000${entry.package}`;
      if (seen.has(key)) {
        errors.push(`${where} duplicates ${entry.id} for ${entry.package}`);
      }
      seen.add(key);
    }
  });

  return errors;
}

const findingsOf = (advisory) =>
  Array.isArray(advisory.findings)
    ? advisory.findings.flatMap((finding) =>
        Array.isArray(finding.paths) ? finding.paths : [],
      )
    : [];

/**
 * Decide what the payload means. Pure: no filesystem, no network, no clock
 * beyond the injected `now`.
 */
export function checkAudit({ report, allowlist, now = new Date() }) {
  const today = isoDate(now);

  if (report?.error) {
    const detail = report.error.summary || report.error.code || 'unknown error';
    return {
      exitCode: 1,
      blockedReason: `pnpm audit failed: ${detail}`,
      allowed: [],
      unallowed: [],
      moderate: [],
      expired: [],
      stale: [],
      invalid: [],
      total: 0,
    };
  }

  if (report?.advisories === null || typeof report?.advisories !== 'object') {
    return {
      exitCode: 1,
      blockedReason: 'pnpm audit returned no advisories object (registry error?)',
      allowed: [],
      unallowed: [],
      moderate: [],
      expired: [],
      stale: [],
      invalid: [],
      total: 0,
    };
  }

  const invalid = validateAllowlist(allowlist);
  const entries = Array.isArray(allowlist) ? allowlist : [];

  const allowed = [];
  const unallowed = [];
  const moderate = [];
  const matchedEntries = new Set();

  for (const [key, advisory] of Object.entries(report.advisories)) {
    const id = advisory.github_advisory_id || `npm-${key}`;
    const pkg = advisory.module_name || '(unknown)';
    const severity = String(advisory.severity || '').toLowerCase();
    const paths = findingsOf(advisory);

    if (!SEVERE.has(severity)) {
      moderate.push({ id, package: pkg, severity, paths });
      continue;
    }

    const match = entries.find((entry) => entry.id === id && entry.package === pkg);
    if (match) {
      matchedEntries.add(match);
      allowed.push({ id, package: pkg, severity, paths });
    } else {
      unallowed.push({ id, package: pkg, severity, paths });
    }
  }

  const expired = entries.filter(
    (entry) => typeof entry.expires === 'string' && DATE.test(entry.expires) && entry.expires < today,
  );
  const stale = entries.filter((entry) => !matchedEntries.has(entry));

  const exitCode = invalid.length > 0 || expired.length > 0 || unallowed.length > 0 ? 1 : 0;

  return {
    exitCode,
    blockedReason: null,
    allowed,
    unallowed,
    moderate,
    expired,
    stale,
    invalid,
    total: Object.keys(report.advisories).length,
  };
}

export function formatReport(result) {
  const lines = [];
  lines.push('');
  lines.push('  Vyloop dependency audit');
  lines.push('  ' + '-'.repeat(60));

  if (result.blockedReason) {
    lines.push(`  [FAIL] ${result.blockedReason}`);
    lines.push('  ' + '-'.repeat(60));
    lines.push('  BLOCKED — the audit did not produce a result to judge.');
    lines.push('');
    return lines.join('\n');
  }

  if (result.invalid.length > 0) {
    lines.push(`  [FAIL] ${result.invalid.length} unusable allowlist entr${result.invalid.length === 1 ? 'y' : 'ies'}`);
    for (const message of result.invalid) lines.push(`    - ${message}`);
  }

  if (result.expired.length > 0) {
    lines.push(`  [FAIL] ${result.expired.length} expired allowlist entr${result.expired.length === 1 ? 'y' : 'ies'}`);
    for (const entry of result.expired) {
      lines.push(`    - ${entry.package} (${entry.id}) expired on ${entry.expires}`);
    }
  }

  if (result.unallowed.length > 0) {
    lines.push(`  [FAIL] ${result.unallowed.length} unallowlisted high/critical advisor${result.unallowed.length === 1 ? 'y' : 'ies'}`);
    for (const advisory of result.unallowed) {
      lines.push(`    - ${advisory.package} (${advisory.id}), ${advisory.severity}`);
      for (const path of advisory.paths) lines.push(`      ${path}`);
    }
  }

  if (result.allowed.length > 0) {
    lines.push(`  note: ${result.allowed.length} high/critical advisor${result.allowed.length === 1 ? 'y is' : 'ies are'} covered by the allowlist.`);
  }
  if (result.moderate.length > 0) {
    lines.push(`  note: ${result.moderate.length} moderate or lower advisor${result.moderate.length === 1 ? 'y was' : 'ies were'} ignored.`);
  }
  if (result.stale.length > 0) {
    lines.push(`  note: ${result.stale.length} allowlist entr${result.stale.length === 1 ? 'y matches' : 'ies match'} no current advisory (stale, not a failure).`);
  }

  lines.push('  ' + '-'.repeat(60));
  if (result.exitCode === 0) {
    lines.push('  PASS — no unallowlisted high or critical advisory.');
  } else {
    lines.push('  BLOCKED — a high or critical advisory is not accepted, or an acceptance expired.');
  }
  lines.push('');
  return lines.join('\n');
}

/** Read and parse the allowlist. Throws on an unreadable or non-JSON file. */
export function readAllowlist(path = ALLOWLIST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function flagValue(argv, flag, fallback) {
  const at = argv.indexOf(flag);
  if (at === -1 || argv[at + 1] === undefined) return fallback;
  return argv[at + 1];
}

function runPnpmAudit() {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  return spawnSync(command, ['audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

export function main(argv = [], { runAudit = runPnpmAudit, now = new Date() } = {}) {
  const allowlistPath = flagValue(argv, '--allowlist', ALLOWLIST_PATH);

  let allowlist;
  try {
    allowlist = readAllowlist(allowlistPath);
  } catch (error) {
    process.stdout.write(
      `\n  Vyloop dependency audit\n  ${'-'.repeat(60)}\n` +
        `  [FAIL] could not read ${allowlistPath}: ${error.message}\n` +
        `  ${'-'.repeat(60)}\n  BLOCKED — nothing was verified.\n\n`,
    );
    return 1;
  }

  const audit = runAudit();
  if (audit.error) {
    process.stdout.write(
      formatReport({
        exitCode: 1,
        blockedReason: `pnpm audit could not run: ${audit.error.message}`,
        allowed: [],
        unallowed: [],
        moderate: [],
        expired: [],
        stale: [],
        invalid: [],
        total: 0,
      }),
    );
    return 1;
  }

  if (!audit.stdout || audit.stdout.trim() === '') {
    const detail = (audit.stderr || '').trim().split('\n')[0] || 'no output';
    process.stdout.write(
      formatReport({
        exitCode: 1,
        blockedReason: `pnpm audit returned no JSON: ${detail}`,
        allowed: [],
        unallowed: [],
        moderate: [],
        expired: [],
        stale: [],
        invalid: [],
        total: 0,
      }),
    );
    return 1;
  }

  let report;
  try {
    report = parseAuditReport(audit.stdout);
  } catch (error) {
    process.stdout.write(
      formatReport({
        exitCode: 1,
        blockedReason: error.message,
        allowed: [],
        unallowed: [],
        moderate: [],
        expired: [],
        stale: [],
        invalid: [],
        total: 0,
      }),
    );
    return 1;
  }

  const result = checkAudit({ report, allowlist, now });
  process.stdout.write(formatReport(result));
  return result.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
