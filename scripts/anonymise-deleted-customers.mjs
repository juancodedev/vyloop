// Anonymise customers deleted before deletion anonymised anything.
//
// ## Why this exists
//
// Until `customer-profile-redesign` Phase 5, the merchant's
// `DELETE /v1/customers/:id` only set `customers.deleted_at`. Those rows kept the
// customer's name, phone, email, birth date and the free text of their history,
// and kept the phone reserved by `uq_customers_business_phone`, so the person
// could never register again at that business. Deleting them again does not help:
// a repeated delete is a 204 that changes nothing, by design.
//
// This applies the same rule the worker applies on a delete today
// (`workers/customer/src/account-deletion.ts`) to every customer that is already
// deleted and still holds personal data. A test reads that file and fails if the
// two drift apart.
//
// ## Why a script and not a migration
//
// Migrations here are schema changes, applied by hand and checked by the
// migration drift gate before every deploy. A data backfill in the journal would
// block every deploy until someone ran it, and it has no schema object the gate
// could find as evidence. A one-off script is run once, by a person, on purpose.
//
// ## What it does not do
//
// - It does not touch `deleted_at`: these customers were deleted when they were.
// - It does not expire Google Wallet passes. The wallet's daily sweep already
//   retries every pass of a deleted customer that is not expired, so those passes
//   converge on their own after this runs.
//
// ## Safety
//
// A dry run is the default and only reads. `--apply` runs every statement in
// one transaction: all of it lands, or none of it.
//
// Usage:
//   node scripts/anonymise-deleted-customers.mjs           # report what would change
//   node scripts/anonymise-deleted-customers.mjs --apply   # anonymise them
//
// `DATABASE_URL` from the environment. Not part of the shipped product: an
// operational script, kept out of `src`.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertVerifiedTls } from './lib/database-url.mjs';

/** `customers` columns set to null, as the worker's delete sets them. */
export const CUSTOMER_CLEARS = [
  'full_name',
  'phone',
  'email',
  'birth_date',
  'identity_doc',
  'identity_type',
  'member_code',
  'metadata',
];

/** Kept history, with its free text emptied. `payload` is NOT NULL, hence `{}`. */
export const CHILD_CLEARS = {
  points_transactions: { note: 'NULL' },
  checkins: { note: 'NULL', items: 'NULL' },
  customer_events: { payload: `'{}'::jsonb` },
  message_log: { content: 'NULL', metadata: 'NULL' },
  consents: { ip_address: 'NULL' },
};

/** Rows that go entirely. */
export const CHILD_DELETES = ['push_subscriptions', 'churn_predictions'];

const STILL_HOLDS_DATA = CUSTOMER_CLEARS.map((column) => `${column} IS NOT NULL`).join(' OR ');

/** How many deleted customers still hold personal data, per business. */
export const COUNT_SQL = `
  SELECT business_id, count(*) AS customers
  FROM customers
  WHERE deleted_at IS NOT NULL AND (${STILL_HOLDS_DATA})
  GROUP BY business_id
  ORDER BY business_id
`;

/**
 * The statements `--apply` runs, in order, inside one transaction.
 *
 * The targets are fixed first, so the children are cleared for exactly the
 * customers whose row is anonymised, and every write is scoped by customer and
 * business together, as the worker scopes them.
 */
export function applyStatements() {
  const statements = [
    `CREATE TEMP TABLE anonymise_targets ON COMMIT DROP AS
       SELECT id, business_id FROM customers
       WHERE deleted_at IS NOT NULL AND (${STILL_HOLDS_DATA})`,
    `UPDATE customers c
       SET ${CUSTOMER_CLEARS.map((column) => `${column} = NULL`).join(', ')}, updated_at = now()
       FROM anonymise_targets t
       WHERE c.id = t.id AND c.business_id = t.business_id`,
  ];
  for (const [table, columns] of Object.entries(CHILD_CLEARS)) {
    const set = Object.entries(columns)
      .map(([column, value]) => `${column} = ${value}`)
      .join(', ');
    statements.push(
      `UPDATE ${table} x SET ${set}
         FROM anonymise_targets t
         WHERE x.customer_id = t.id AND x.business_id = t.business_id`,
    );
  }
  for (const table of CHILD_DELETES) {
    statements.push(
      `DELETE FROM ${table} x
         USING anonymise_targets t
         WHERE x.customer_id = t.id AND x.business_id = t.business_id`,
    );
  }
  return statements;
}

export function parseArgs(argv) {
  const unknown = argv.filter((arg) => arg !== '--apply');
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown.join(' ')}. Only --apply is accepted.`);
  return { apply: argv.includes('--apply') };
}

/**
 * Report, and with `apply` anonymise. `pool` is anything with `connect()`
 * returning a client with `query` and `release`, so tests need no database.
 */
export async function run({ apply, pool }) {
  const client = await pool.connect();
  try {
    const counted = await client.query(COUNT_SQL);
    const byBusiness = counted.rows.map((row) => ({
      business_id: row.business_id,
      customers: Number(row.customers),
    }));
    const pending = byBusiness.reduce((sum, row) => sum + row.customers, 0);
    if (!apply || pending === 0) return { applied: false, pending, byBusiness };

    await client.query('BEGIN');
    try {
      for (const sql of applyStatements()) await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    return { applied: true, pending, byBusiness };
  } finally {
    client.release();
  }
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  assertVerifiedTls(url);

  const require = createRequire(join(process.cwd(), 'packages/db/package.json'));
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });

  try {
    const report = await run({ apply, pool });
    for (const row of report.byBusiness) console.log(`${row.business_id}\t${row.customers}`);
    if (report.applied) console.log(`Anonymised ${report.pending} deleted customer(s).`);
    else if (report.pending === 0) console.log('No deleted customer still holds personal data.');
    else console.log(`${report.pending} deleted customer(s) still hold personal data. Run with --apply to anonymise them.`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
