import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

/**
 * Session-variable names. Two distinct names, deliberately.
 *
 * The wallet tables are keyed by `tenant_id`; the rest of the model is keyed by
 * `business_id`. Emitting one policy shape for both would produce SQL that
 * references a column the table does not have, so the two shapes get their own
 * variable and their own set of helpers. Using one name for both would also
 * make it impossible to tell from `pg_policies` which scoping a given policy
 * actually applies.
 */
export const BUSINESS_ID_SETTING = 'app.current_business_id';
export const TENANT_ID_SETTING = 'app.current_tenant_id';

/** Name of the policy created on every tenant-scoped table. */
export const RLS_POLICY_NAME = 'tenant_isolation';

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
  'message_log',
  'whatsapp_templates',
] as const;

/**
 * Tables keyed by `tenant_id` rather than `business_id`.
 *
 * These must never be added to `BUSINESS_ID_TABLES`: a policy of the form
 * `USING (business_id = ...)` on a table without a `business_id` column is a
 * hard error at policy-creation time, not a silent no-op, so a mistake here
 * surfaces as a failed rollout rather than as a data leak. It is still
 * asserted in the test suite, because "it would fail loudly" is not a strategy.
 *
 * `tenant_wallet_programs` is a one-row-per-tenant table whose `tenant_id` is
 * also its primary key. `customer_wallet_passes` carries `tenant_id`
 * explicitly, and it is not derivable from `customer_id` without a join, which
 * is exactly the sort of implicit link a policy should not depend on.
 */
export const TENANT_ID_TABLES = ['tenant_wallet_programs', 'customer_wallet_passes'] as const;

/**
 * Render a `current_setting(...)` comparison against a uuid column.
 *
 * `current_setting` returns `text`, so the cast is required. The cast target
 * must match the column type or Postgres raises "operator does not exist";
 * every column in both table lists is a `uuid`, which `rls.test.ts` asserts
 * against the live Drizzle schema rather than against a comment.
 */
function policyPredicate(column: string, setting: string): string {
  return `${column} = current_setting('${setting}')::UUID`;
}

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
  const predicate = policyPredicate('business_id', BUSINESS_ID_SETTING);
  return BUSINESS_ID_TABLES.map(
    (table) =>
      sql.raw(
        `CREATE POLICY ${RLS_POLICY_NAME} ON "${table}" USING (${predicate});`,
      ),
  ).map((raw) => sql`${raw}`);
}

/**
 * Drop existing `tenant_isolation` policies — useful for reset/reapply.
 */
export function dropRlsPolicies(): SQL[] {
  return BUSINESS_ID_TABLES.map(
    (table) =>
      sql.raw(`DROP POLICY IF EXISTS ${RLS_POLICY_NAME} ON "${table}";`),
  ).map((raw) => sql`${raw}`);
}

/**
 * Enable RLS on every table keyed by `tenant_id`.
 *
 * Separate from `enableRls()` rather than folded into it, so that a rollout
 * can be staged: business-scoped tables and tenant-scoped tables are different
 * risks and may need to go live on different days. Calling `enableRls()` alone
 * must never switch on isolation for the wallet tables by surprise.
 */
export function enableTenantRls(): SQL[] {
  return TENANT_ID_TABLES.map(
    (table) => sql.raw(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`),
  ).map((raw) => sql`${raw}`);
}

/**
 * Create the `tenant_isolation` policy on every `tenant_id` table, comparing
 * `tenant_id` against `app.current_tenant_id`.
 *
 * The shape mirrors `createRlsPolicies()` exactly except for the column and
 * the session variable, so both shapes can be validated by the same tests.
 */
export function createTenantRlsPolicies(): SQL[] {
  const predicate = policyPredicate('tenant_id', TENANT_ID_SETTING);
  return TENANT_ID_TABLES.map(
    (table) =>
      sql.raw(
        `CREATE POLICY ${RLS_POLICY_NAME} ON "${table}" USING (${predicate});`,
      ),
  ).map((raw) => sql`${raw}`);
}

/**
 * Drop the `tenant_isolation` policy from every `tenant_id` table.
 */
export function dropTenantRlsPolicies(): SQL[] {
  return TENANT_ID_TABLES.map(
    (table) =>
      sql.raw(`DROP POLICY IF EXISTS ${RLS_POLICY_NAME} ON "${table}";`),
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

/**
 * The `tenant_id` counterpart of `setCurrentBusinessId`.
 *
 * Set this before reading or writing any table listed in `TENANT_ID_TABLES`.
 * Setting one does not satisfy the other: a transaction that sets only
 * `app.current_business_id` and then queries `customer_wallet_passes` will not
 * see any rows once that table's RLS is enabled.
 */
export function setCurrentTenantId(id: string): SQL {
  return sql`SELECT set_config('app.current_tenant_id', ${id}, true);`;
}

/**
 * Set the `app.current_tenant_id` session variable for the current transaction.
 *
 * This lives in `@vyloop/db` rather than being copied into each worker's
 * `helpers.ts`, unlike its `withRls` counterpart. That asymmetry is the point:
 * `withRls` was duplicated into four workers and now has four independent
 * definitions of the same security-relevant statement. The session-context
 * contract is a property of the database, so it has one home here and workers
 * import it.
 *
 * @param db A Drizzle instance, e.g. the return value of `createDb`.
 * @param tenantId The `tenants.id` that owns the rows being touched.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function withTenantRls(db: any, tenantId: string): Promise<void> {
  await db.execute(setCurrentTenantId(tenantId));
}
