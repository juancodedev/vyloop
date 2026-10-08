// Payment reconciliation: settlements we recorded and no sale we attributed.
//
// Reports `settled_payments` rows with no `checkins` row naming the same
// `payment_id` — the payments the rail says settled and that nothing in this
// system ever attached to a loyalty pass.
//
// ## What this does NOT do, and why
//
// It does not credit anything, and it must not. **A payment webhook detects a lost
// attribution; it cannot repair one.** The webhook carries the payment and the
// amount. It does **not** carry the fact that a loyalty pass was scanned — only the
// terminal knows that. So a row this script reports says *that* an attribution was
// lost, and nothing about *whose*. There is no repair button, and building one
// would mean guessing a customer from a payment id, which would put points on
// somebody's balance for a purchase they may not have made.
//
// Recovery is one of exactly two things, and both are outside this script:
//
//   - the terminal resends `POST /v1/loyalty/checkins` with the same `payment_id`,
//     which is the recovery path the retry contract already promises; or
//   - a person asks the cashier, and the sale is re-reported.
//
// The first is automatic and this report exists so you learn it did not happen. The
// second is a phone call.
//
// ## Why `check-checkin-backlog.mjs` cannot do this job
//
// That script answers a different question: sales that were **recorded** and not
// credited. `points IS NULL` is the signal, so it needs a row to look at. A sale
// that was never reported has no row at all — no checkin, no points, nothing. It is
// invisible to that script by construction, which is the whole reason this one
// exists and the whole reason the two must not be merged.
//
// ## Read-only, always
//
// Same contract as `check-checkin-backlog.mjs` and the migration drift gate:
// `default_transaction_read_only` is set and then *verified* with `SHOW`, because a
// session that quietly accepted writes anyway would make "this script never writes"
// an assumption rather than a fact.
//
// An unreachable database is a failure and not an empty report. Reporting "every
// sale is attributed" from a database we could not open is precisely the failure
// this exists to prevent, so it fails closed and exits non-zero.
//
// Not part of the shipped test suite as product code: an operational script, kept
// out of `src` so it is neither linted nor typechecked as product code. Its own
// tests sit beside it and are run by `npx vitest run --dir scripts`.
//
// Usage:
//   node scripts/check-payment-reconciliation.mjs            # report, exit 1 if any
//   node scripts/check-payment-reconciliation.mjs --report   # always exit 0
//
// `DATABASE_URL` from the environment, falling back to the local dev file.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const DEV_VARS_CANDIDATES = [
  'workers/growth/.dev.vars',
  'apps/gateway/.dev.vars',
  '.dev.vars',
];

/**
 * The count, and what it is.
 *
 * `min(received_at)` rather than the rail's settlement date: the gap between a
 * payment settling at the rail and arriving here is a different failure from one
 * that never arrived, and collapsing them into a single "settled at" would hide
 * exactly the case where deliveries are being dropped somewhere in between.
 */
export const SUMMARY_SQL = `
  SELECT
    count(*)                                    AS perdidas,
    coalesce(sum(s.amount_cents), 0)            AS monto_cents,
    min(s.received_at)                          AS mas_vieja,
    max(s.received_at)                          AS mas_reciente
  FROM settled_payments s
  WHERE NOT EXISTS (
    SELECT 1 FROM checkins c WHERE c.payment_id = s.payment_id
  )
`;

/**
 * One row per merchant, worst first.
 *
 * Scoped on `business_id` as well as `payment_id` in the `NOT EXISTS`, so a
 * merchant whose till reported a sale and whose rail reported the same payment are
 * treated as one event. The join to `checkins` in the backlog script is deliberately
 * *not* mirrored here: that one is finding rows that need work, this one is finding
 * payments that need a phone call.
 */
export const BY_BUSINESS_SQL = `
  SELECT
    t.name                       AS negocio,
    s.business_id                AS business_id,
    count(*)                     AS perdidas,
    coalesce(sum(s.amount_cents), 0) AS monto_cents,
    min(s.received_at)           AS mas_vieja
  FROM settled_payments s
  JOIN tenants t ON t.id = s.business_id
  WHERE NOT EXISTS (
    SELECT 1 FROM checkins c
    WHERE c.payment_id = s.payment_id AND c.business_id = s.business_id
  )
  GROUP BY t.name, s.business_id
  ORDER BY min(s.received_at) ASC
`;

/**
 * The individual payments.
 *
 * `LIMIT 50` on purpose: this is the part a person reads, and a merchant with ten
 * thousand unattributed sales is a conversation, not a list. The summary above is
 * what a monitoring job alerts on; this is what a human opens.
 */
export const LOST_SQL = `
  SELECT
    s.payment_id, t.name AS negocio, s.amount_cents, s.received_at
  FROM settled_payments s
  JOIN tenants t ON t.id = s.business_id
  WHERE NOT EXISTS (
    SELECT 1 FROM checkins c
    WHERE c.payment_id = s.payment_id AND c.business_id = s.business_id
  )
  ORDER BY s.received_at ASC
  LIMIT 50
`;

function resolveUrl() {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, source: 'DATABASE_URL' };
  for (const candidate of DEV_VARS_CANDIDATES) {
    try {
      const value = /^DATABASE_URL=(.*)$/m.exec(readFileSync(candidate, 'utf8'))?.[1];
      if (value) return { url: value, source: candidate };
    } catch {
      // missing file, try the next one
    }
  }
  return { url: null, source: null };
}

export async function observe(url, { connectTimeoutMs = 10_000 } = {}) {
  if (!url) return { reachable: false, error: 'DATABASE_URL is not set' };

  const require = createRequire(join(process.cwd(), 'packages/db/package.json'));
  const { Pool } = require('pg');

  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: connectTimeoutMs,
  });

  try {
    // Every failure below is a *value*, never a throw. `check-checkin-backlog.mjs`
    // lets a connection error escape to the `main` catch, which exits 1 -- correct,
    // but it prints a stack trace, and this script's whole reason for existing is
    // that "we could not check" and "there is nothing to report" must not look alike
    // to whoever reads the output. A stack trace is the least legible form of that
    // distinction. Caught here so `formatReport` can say BLOCKED, which is the shape
    // an operator can act on.
    await pool.query('SET default_transaction_read_only = on');
    const mode = await pool.query('SHOW default_transaction_read_only');
    if (mode.rows[0]?.default_transaction_read_only !== 'on') {
      return {
        reachable: false,
        error: 'the database did not honour a read-only session; refusing to continue',
      };
    }

    const summary = (await pool.query(SUMMARY_SQL)).rows[0];
    const byBusiness = (await pool.query(BY_BUSINESS_SQL)).rows;
    const lost = (await pool.query(LOST_SQL)).rows;

    return { reachable: true, summary, byBusiness, lost };
  } catch (error) {
    return { reachable: false, error: describeConnectionFailure(error) };
  } finally {
    await pool.end();
  }
}

/**
 * One line saying what went wrong, with the message the driver gave.
 *
 * The driver's own message is kept because it is the only part that distinguishes
 * "the host is down" from "the password is wrong" from "the port is firewalled", and
 * an operator cannot act on "unreachable". It is truncated so a multi-line driver
 * error cannot smear across the report.
 */
function describeConnectionFailure(error) {
  const detail = error instanceof Error ? error.message : String(error);
  return `could not read the database: ${detail.split('\n')[0]}`;
}

function humanizeAge(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export function formatReport(observation, { reportOnly = false } = {}) {
  const lines = [];
  lines.push('  Vyloop payment reconciliation');
  lines.push('  ------------------------------------------------------------');

  if (!observation.reachable) {
    lines.push(`  [BLOCKED] ${observation.error}`);
    lines.push('');
    lines.push(
      '  Cannot verify reconciliation: the database was unreachable. This reports ' +
        'blocked on purpose — a clean reconciliation read from a database we could ' +
        'not open is indistinguishable from a real one, and that ambiguity is the ' +
        'failure this exists to prevent.',
    );
    return { lines, exitCode: 1 };
  }

  const s = observation.summary;
  const lost = Number(s.perdidas ?? 0);
  const cents = Number(s.monto_cents ?? 0);

  if (lost === 0) {
    lines.push('  [OK] every settled payment we recorded has a checkin');
  } else {
    lines.push(`  [LOST] ${lost} settled payment(s) with no checkin`);
    lines.push(`     oldest: ${humanizeAge(s.mas_vieja)}   newest: ${humanizeAge(s.mas_reciente)}`);
    lines.push(`     money with no attribution: $${(cents / 100).toFixed(2)}`);
    lines.push('');
    lines.push('     A webhook detects a lost attribution. It cannot repair one: the');
    lines.push('     payment carries no pass, so this says THAT an attribution was lost,');
    lines.push('     never WHOSE. Recovery is the terminal resending the checkin, or a');
    lines.push('     person asking the cashier. There is no repair from here.');

    if (observation.byBusiness.length > 0) {
      lines.push('');
      lines.push('     by merchant');
      for (const row of observation.byBusiness) {
        lines.push(
          `       ${String(row.negocio).padEnd(24)} ${String(row.perdidas).padStart(4)} lost` +
            `  $${(Number(row.monto_cents) / 100).toFixed(2)}` +
            `  oldest ${humanizeAge(row.mas_vieja)}`,
        );
      }
    }

    if (observation.lost.length > 0) {
      lines.push('');
      lines.push('     payments (ask each merchant for these — we cannot attribute them)');
      for (const row of observation.lost) {
        lines.push(
          `       ${row.payment_id}  ${String(row.negocio).padEnd(20)}` +
            `  $${(Number(row.amount_cents) / 100).toFixed(2)}  ${humanizeAge(row.received_at)}`,
        );
      }
    }
  }

  return { lines, exitCode: reportOnly ? 0 : lost > 0 ? 1 : 0 };
}

async function main(argv) {
  const reportOnly = argv.includes('--report');
  const { url, source } = resolveUrl();

  const observation = await observe(url);
  const { lines, exitCode } = formatReport(observation, { reportOnly });

  process.stdout.write(`${lines.join('\n')}\n`);
  if (source) process.stdout.write(`  database url read from ${source}\n`);
  process.stdout.write('\n');

  return exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error('payment reconciliation check failed:', error);
      process.exitCode = 1;
    });
}