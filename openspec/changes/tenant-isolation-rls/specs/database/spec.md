# Delta for database

## MODIFIED Requirements

### Requirement: RLS

Every table that carries a `business_id` column MUST have row-level security enabled with a `tenant_isolation` policy comparing `business_id` against `current_setting('app.current_business_id')::UUID`. Every table keyed by `tenant_id` instead MUST have the same policy shape against `app.current_tenant_id`. The `consents` table MUST be part of the `business_id` set: it is the authoritative store for a customer's consent, so a cross-tenant read of it is a disclosure of what a customer agreed to.

The policy predicate MUST NOT pass `missing_ok` to `current_setting`. A query that reaches a table with row-level security enabled and no tenant context MUST fail with an error rather than return zero rows.

`tenants` and `cross_loyalty_alliances` are exempt: `tenants` is the root of the hierarchy and has no `business_id`, and `cross_loyalty_alliances` is keyed by two tenants.

#### Scenario: Isolation

- GIVEN a transaction whose `app.current_business_id` is tenant A
- WHEN it queries `customers`
- THEN only tenant A's rows are visible

#### Scenario: Consents are tenant-scoped

- GIVEN a consent recorded for tenant A
- WHEN tenant B queries `consents` for the same customer
- THEN no row is visible

#### Scenario: Wallet tables use the tenant variable

- GIVEN a transaction that set only `app.current_business_id` to tenant A
- WHEN it queries `customer_wallet_passes`
- THEN the query fails, because `app.current_tenant_id` is not set

#### Scenario: A query with no tenant context fails loudly

- GIVEN row-level security enabled on `customers`
- WHEN a query reads `customers` on a connection where no tenant variable was set in the current transaction
- THEN the query raises an error
- AND it does not return an empty result

## ADDED Requirements

### Requirement: Transaction-Scoped Tenant Context

The tenant context MUST be set with `set_config(name, value, true)` inside the same transaction as the queries it scopes. `@vyloop/db` MUST export one helper, `withTenantTransaction`, that opens a transaction, sets `app.current_business_id` and/or `app.current_tenant_id` on it, and runs the caller's queries on that transaction handle. Workers and `apps/gateway` MUST NOT set the tenant context with a statement executed on the pool outside a transaction, and MUST NOT use a session-level `SET`, because the production connection goes through Neon's transaction pooler and a pooled client may serve the next statement.

#### Scenario: Every statement in the callback sees the tenant

- GIVEN `withTenantTransaction(db, { businessId: A }, fn)`
- WHEN `fn` runs two queries on the handle it receives
- THEN both queries see `app.current_business_id = A`

#### Scenario: The context does not leak past the transaction

- GIVEN a `withTenantTransaction` call for tenant A that has committed
- WHEN the same pool runs another query outside any tenant transaction
- THEN `current_setting('app.current_business_id', true)` is empty for that query

#### Scenario: No runtime sets the context outside a transaction

- GIVEN the source of every worker under `workers/` and of `apps/gateway/src/`
- WHEN it is searched for `withRls(db`, `openTenantSession(`, or a raw `setCurrentBusinessId(`/`setCurrentTenantId(` outside `packages/db/src/rls.ts`
- THEN no call site is found
- AND `workers/analytics` and `apps/gateway/src/merchant-store.ts` are included in the search

### Requirement: Non-Owner Application Role

Workers MUST connect with a role that owns no table and does not have `BYPASSRLS`, and that holds only `SELECT`, `INSERT`, `UPDATE` and `DELETE` on application tables and `USAGE` on their sequences. The owner role MUST be reserved for migrations and read-only operational scripts. Roles MUST be created outside migration files.

#### Scenario: The worker role is subject to policies

- GIVEN the role in a worker's `DATABASE_URL`
- WHEN `pnpm db:rls` inspects it
- THEN it reports that the role owns no application table
- AND that it does not have `BYPASSRLS`

### Requirement: Complete RLS Table Lists

Every table in `packages/db/src/schema.ts` that carries a `business_id` column MUST appear in `BUSINESS_ID_TABLES`, every table that carries a `tenant_id` column MUST appear in `TENANT_ID_TABLES`, unless it is named in an explicit exemption list with a reason. A test MUST enforce this against the Drizzle schema, so adding a table without classifying it fails the suite.

#### Scenario: A new table is not classified

- GIVEN a new table with a `business_id` column in `schema.ts`
- WHEN it is in neither `BUSINESS_ID_TABLES` nor the exemption list
- THEN `packages/db/src/rls.test.ts` fails and names the table

#### Scenario: The current gaps are closed

- GIVEN the schema as of 2026-10-20
- WHEN the lists are checked
- THEN `push_subscriptions` is in `BUSINESS_ID_TABLES`
- AND `wallet_callback_deliveries` is in `TENANT_ID_TABLES`

### Requirement: Cross-Tenant Jobs Run Per Tenant

A scheduled job that touches more than one tenant MUST enumerate tenants from `tenants` and perform each tenant's work inside its own `withTenantTransaction`. Workers MUST NOT be given a role with `BYPASSRLS`. A failure for one tenant MUST NOT stop the job for the others, and MUST be reported with the tenant id.

This applies to `handleSubscriptionMaintenance` (communication), `runScheduledSweep` and the inactivity deactivation (wallet), and `handleBirthdayCron` and `handleInactivityCron` (automation).

#### Scenario: The push sweep prunes a deleted customer's subscriptions under RLS

- GIVEN row-level security enabled on `customers` and `push_subscriptions`
- AND a soft-deleted customer of tenant A with a subscription
- WHEN `handleSubscriptionMaintenance` runs
- THEN that subscription is deleted
- AND the step reports one deletion for tenant A

#### Scenario: One failing tenant does not stop the sweep

- GIVEN tenants A, B and C, and a failure while processing B
- WHEN a cross-tenant job runs
- THEN A and C are processed
- AND the report names B as failed

### Requirement: RLS Verification

A read-only script, `scripts/check-rls.mjs`, run as `pnpm db:rls`, MUST report for every table in `BUSINESS_ID_TABLES` and `TENANT_ID_TABLES` whether row-level security is enabled (`pg_class.relrowsecurity`) and whether the `tenant_isolation` policy exists (`pg_policies`), and MUST report the connecting role's `rolbypassrls` and the tables it owns. It MUST put its session in read-only mode before querying, as `check-migration-drift.mjs` does. It MUST accept an expected-state argument per rollout phase and exit non-zero when the database differs from it.

#### Scenario: The wallet phase is verified

- GIVEN the phase-3 migration applied
- WHEN `pnpm db:rls -- --expect wallet` runs
- THEN it exits 0 and lists the three wallet tables as enabled with a policy
- AND it lists the business tables as not enabled

#### Scenario: A table is missing its policy

- GIVEN RLS enabled on a table without the `tenant_isolation` policy
- WHEN `pnpm db:rls` runs with an expectation that includes the table
- THEN it exits non-zero and names the table
