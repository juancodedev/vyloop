// Checkin credit backlog.
//
// Reports the checkins whose sale was recorded but whose points were never
// credited — the one state in that table that means a customer paid and got
// nothing.
//
// ## What this does NOT do, and why
//
// It does not credit anything. That is deliberate, and it is the whole design.
//
// `POST /v1/checkins` already drains this: when a request conflicts on
// `(business_id, payment_id)` and finds a row whose `points` is still NULL, it
// re-runs the credit (`workers/growth/src/routes.ts`). So a terminal that
// honours its retry contract empties this backlog on its own, and the correct
// operational response to a non-empty backlog is **not** "drain it by hand" — it
// is "find out why retries are not arriving".
//
// Adding a second credit path would also be a correctness hazard rather than
// merely redundant: `creditCheckin` resolves the tenant's program config and the
// customer's tier at the moment of the charge, and a copy of it would be free to
// drift from the original the same way the POS preview once drifted from the
// charge. One path that owns the credit is worth more than two paths that each
// claim to.
//
// ## The two kinds of pending row are not the same failure
//
// `payment_id IS NOT NULL`  — the terminal reported a settled sale. A retry
//                            arrives by contract and clears it.
//
// `payment_id IS NULL`      — a person registered the sale from the dashboard.
//                            **Nothing retries this.** There is no external
//                            party to resend anything, and the manual path has
//                            no dedupe key either. A manual entry whose credit
//                            failed is stuck until a human looks at it.
//
// The second kind is the one that justifies this script existing at all. The
// first kind is self-healing, so counting it as a problem would train an operator
// to ignore the report.
//
// ## Read-only, always
//
// Same contract as the migration drift gate: `default_transaction_read_only` is
// set and then *verified*, because a session that quietly accepted writes anyway
// would make "this script never writes" an assumption rather than a fact. An
// unreachable database is a failure and not an empty report — reporting "no
// backlog" from a database we could not read is the exact failure mode this
// exists to prevent.
//
// Not part of the shipped test suite: an operational script, kept out of `src` so
// it is neither linted nor typechecked as product code.
//
// Usage:
//   node scripts/check-checkin-backlog.mjs            # report, exit 1 if pending
//   node scripts/check-checkin-backlog.mjs --report   # always exit 0
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

export const SUMMARY_SQL = `
  SELECT
    count(*) FILTER (WHERE points IS NULL)                                  AS pendientes,
    count(*) FILTER (WHERE points IS NULL AND payment_id IS NULL)          AS vias_manuales,
    count(*) FILTER (WHERE points IS NULL AND payment_id IS NOT NULL)      AS vias_terminal,
    min(created_at) FILTER (WHERE points IS NULL)                          AS mas_viejo,
    count(*) FILTER (WHERE points IS NOT NULL)                             AS acreditados,
    coalesce(sum(amount_cents) FILTER (WHERE points IS NULL), 0)           AS monto_pendiente_cents
  FROM checkins
`;

export const BY_BUSINESS_SQL = `
  SELECT
    t.name                                             AS negocio,
    c.business_id                                      AS business_id,
    count(*)                                           AS pendientes,
    count(*) FILTER (WHERE c.payment_id IS NULL)       AS vias_manuales,
    min(c.created_at)                                  AS mas_viejo,
    sum(c.amount_cents)                                AS monto_pendiente_cents
  FROM checkins c
  JOIN tenants t ON t.id = c.business_id
  WHERE c.points IS NULL
  GROUP BY t.name, c.business_id
  ORDER BY min(c.created_at) ASC
`;

/** Rows the manual path can never recover on its own. */
export const STUCK_SQL = `
  SELECT
    c.id, t.name AS negocio, c.member_code, c.amount_cents, c.created_at
  FROM checkins c
  JOIN tenants t ON t.id = c.business_id
  WHERE c.points IS NULL AND c.payment_id IS NULL
  ORDER BY c.created_at ASC
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
    const stuck = (await pool.query(STUCK_SQL)).rows;

    return { reachable: true, summary, byBusiness, stuck };
  } finally {
    await pool.end();
  }
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
  lines.push('  Vyloop checkin credit backlog');
  lines.push('  ------------------------------------------------------------');

  if (!observation.reachable) {
    lines.push(`  [BLOCKED] ${observation.error}`);
    lines.push('');
    lines.push(
      '  Cannot verify the backlog: the database was unreachable. This reports ' +
        'blocked on purpose — a clean backlog read from a database we could not ' +
        'open is indistinguishable from a real one, and that ambiguity is the ' +
        'failure this exists to prevent.',
    );
    return { lines, exitCode: 1 };
  }

  const s = observation.summary;
  const pending = Number(s.pendientes ?? 0);
  const manual = Number(s.vias_manuales ?? 0);
  const terminal = Number(s.vias_terminal ?? 0);
  const credited = Number(s.acreditados ?? 0);

  if (pending === 0) {
    lines.push('  [OK] no sale is waiting for its points');
    lines.push(`         ${credited} credited, none pending`);
  } else {
    lines.push(`  [PENDING] ${pending} sale(s) recorded without points`);
    lines.push(`     oldest: ${humanizeAge(s.mas_viejo)}`);
    lines.push(
      `     money on hold: $${(Number(s.monto_pendiente_cents ?? 0) / 100).toFixed(2)}`,
    );
    lines.push('');
    lines.push(`     terminal path (self-heals on retry): ${terminal}`);
    lines.push(`     manual path  (nothing retries it)  : ${manual}`);

    if (observation.byBusiness.length > 0) {
      lines.push('');
      lines.push('     by merchant');
      for (const row of observation.byBusiness) {
        lines.push(
          `       ${String(row.negocio).padEnd(24)} ${String(row.pendientes).padStart(4)} pending` +
            `  ${String(row.vias_manuales).padStart(4)} stuck` +
            `  $${(Number(row.monto_pendiente_cents) / 100).toFixed(2)}` +
            `  oldest ${humanizeAge(row.mas_viejo)}`,
        );
      }
    }

    if (observation.stuck.length > 0) {
      lines.push('');
      lines.push('     manual entries needing a human (no retry will ever arrive)');
      for (const row of observation.stuck) {
        lines.push(
          `       ${row.id}  ${String(row.negocio).padEnd(20)} ${row.member_code}` +
            `  $${(Number(row.amount_cents) / 100).toFixed(2)}  ${humanizeAge(row.created_at)}`,
        );
      }
    }
  }

  lines.push('');
  if (pending > 0) {
    lines.push(
      '  Retry only, never a manual credit: POST /v1/checkins with the same payment_id re-runs',
    );
    lines.push(
      '  the credit for a pending row. A manual entry has no payment_id, so it has to be read.',
    );
  }

  return { lines, exitCode: reportOnly ? 0 : pending > 0 ? 1 : 0 };
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
      console.error('checkin backlog check failed:', error);
      process.exitCode = 1;
    });
}