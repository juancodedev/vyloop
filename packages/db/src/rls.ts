import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

/**
 * Tables that have a `business_id` column and need RLS.
 * `tenants` is the root table and does NOT have business_id.
 * `cross_loyalty_alliances` uses tenant_a_id / tenant_b_id instead.
 */
export const BUSINESS_ID_TABLES = [
  'branches',
  'users',
  'customers',
  'customer_events',
  'consents',
  'loyalty_programs',
  'membership_tiers',
  'points_transactions',
  'referrals',
  'workflows',
  'workflow_executions',
  'churn_predictions',
  'localization_configs',
  'rewards',
  'reward_grants',
] as const;

/**
 * Enable RLS on every table that has a `business_id` column.
 */
export function enableRls(): SQL[] {
  return BUSINESS_ID_TABLES.map(
    (table) => sql.raw(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`),
  ).map((raw) => sql`${raw}`);
}

/**
 * Create the `tenant_isolation` policy on every business_id table.
 * The policy compares `business_id` against the session variable
 * `app.current_business_id`, which must be set per-request:
 *
 *   SELECT set_config('app.current_business_id', '<tenant-uuid>', true);
 *
 * The third argument `true` limits scope to the current transaction.
 */
export function createRlsPolicies(): SQL[] {
  return BUSINESS_ID_TABLES.map(
    (table) =>
      sql.raw(
        `CREATE POLICY tenant_isolation ON "${table}" ` +
          `USING (business_id = current_setting('app.current_business_id')::UUID);`,
      ),
  ).map((raw) => sql`${raw}`);
}

/**
 * Drop existing `tenant_isolation` policies — useful for reset/reapply.
 */
export function dropRlsPolicies(): SQL[] {
  return BUSINESS_ID_TABLES.map(
    (table) =>
      sql.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${table}";`),
  ).map((raw) => sql`${raw}`);
}

/**
 * Generate a `SELECT set_config(...)` statement to set the business ID for the
 * current transaction. `SET LOCAL` does NOT accept parameterized values,
 * so we use `set_config()` instead which accepts `$1` placeholders.
 *
 * Call this at the start of every authenticated request that touches
 * tenant-scoped tables.
 *
 * @see https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SET
 */
export function setCurrentBusinessId(id: string): SQL {
  return sql`SELECT set_config('app.current_business_id', ${id}, true);`;
}
