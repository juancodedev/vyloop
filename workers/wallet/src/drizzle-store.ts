/**
 * The Drizzle implementation of `WalletStore`.
 *
 * ## Every query is tenant-scoped, in SQL, not in application code
 *
 * Each `WHERE` clause pairs the row's own key with the tenant. That is
 * deliberate belt-and-braces: the `tenant_wallet_programs` and
 * `customer_wallet_passes` tables have row-level security keyed on
 * `tenant_id` (`packages/db/src/rls.ts`, applied with `withTenantRls`), and
 * this layer does not rely on that being switched on. RLS is enabled
 * separately from business-scoped RLS precisely so the two can go live on
 * different days, and a rollout where the policy exists but the code assumes it
 * is the only line of defence is a rollout with no line of defence.
 *
 * The tests compile the predicates with `PgDialect` and admit only rows the
 * predicate matches, so dropping a tenant filter from any method below makes a
 * test fail rather than a leak reach production.
 *
 * ## RLS session variables
 *
 * Two of them, and they are not interchangeable. `withRls(db, businessId)`
 * sets `app.current_business_id` for the `business_id`-keyed tables
 * (`customers`, `loyalty_programs`, `membership_tiers`, `points_transactions`).
 * `withTenantRls(db, tenantId)` sets `app.current_tenant_id` for the two wallet
 * tables. A request that reads a pass touches all four groups, so it must set
 * both — setting one does not satisfy the other, and a request that set only the
 * business variable would see no wallet rows once that policy is live.
 *
 * The session-context statements are issued by the route, next to
 * `createDb`, because that is where every other worker in this repository puts
 * its `withRls` call and a reader comparing the two will expect to find it
 * there. `withTenantRls` itself is imported from `@vyloop/db` rather than
 * reimplemented, for the reason its own doc comment gives.
 */

import {
  createDb,
  customers,
  customerWalletPasses,
  loyaltyPrograms,
  membershipTiers,
  pointsTransactions,
  setCurrentBusinessId,
  setCurrentTenantId,
  tenantWalletPrograms,
  tenants,
} from '@vyloop/db';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

import type {
  ConsentingPassRow,
  InactivityCandidateRow,
  PassCallbackClaim,
  PassCallbackWrite,
  PassLifecycleUpdate,
  PassObservationUpdate,
  PassReconciliationUpdate,
  PassTrackingUpdate,
  ProgramInsert,
  WalletCustomerRow,
  WalletPassRow,
  WalletProgramRow,
  WalletProgramWithBusinessRow,
  WalletStore,
  WalletTenantBrandingRow,
  WalletTenantByClassIdRow,
  WalletTierRow,
} from './store';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/**
 * How many rows a `RETURNING` update actually changed.
 *
 * Every write in this store that can legitimately match nothing reports that
 * through this, and a `Promise<void>` signature would throw the answer away. A
 * `WHERE` guard is only real protection if the caller can find out whether it
 * fired; otherwise a guard that rejects a write looks exactly like one that
 * accepted it, and the sweep counts observations it never recorded.
 */
function countRows(result: unknown): number {
  return (result as { rows?: unknown[] }).rows?.length ?? 0;
}

/**
 * Open a tenant-scoped database session.
 *
 * Both session variables are set, and they are set before anything is read. A
 * missing one is invisible until the matching policy is enabled, which is the
 * worst possible time to find out.
 *
 * Note the two exported statement builders rather than a `withRls` helper:
 * `@vyloop/db` exports `setCurrentBusinessId` and `setCurrentTenantId` but **not**
 * a combined `withRls` — that one lives in each of the four existing workers,
 * which is the duplication `rls.ts` complains about ("four independent
 * definitions of the same security-relevant statement"). Copying a fifth one
 * here would be adding to that. What is duplicated in the four workers is the
 * SQL string; calling these two builders is not duplicating the statement, it is
 * using the one place that owns it.
 *
 * The symmetric fix is to add `withRls` to `@vyloop/db` and have the four
 * workers import it. That is a change to shared code and to four workers' call
 * sites, so it belongs in its own change rather than inside the wallet unit.
 */
export async function openTenantSession(databaseUrl: string, tenantId: string): Promise<Db> {
  const db = createDb(databaseUrl);
  await db.execute(setCurrentBusinessId(tenantId));
  await db.execute(setCurrentTenantId(tenantId));
  return db;
}

const CUSTOMER_COLUMNS = {
  id: customers.id,
  globalId: customers.globalId,
  fullName: customers.fullName,
  memberCode: customers.memberCode,
  currentTierId: customers.currentTierId,
};

const PROGRAM_COLUMNS = {
  tenantId: tenantWalletPrograms.tenantId,
  issuerId: tenantWalletPrograms.issuerId,
  classId: tenantWalletPrograms.classId,
  reviewStatus: tenantWalletPrograms.reviewStatus,
  // The per-tenant demo-mode switch. Selected here so the readiness gate and the
  // pass route see the same value the operator set; a projection that omitted it
  // would read as `undefined` and be treated as demo mode, which would look like
  // the switch silently not working.
  demoMode: tenantWalletPrograms.demoMode,
  // The inactivity window. Selected here for the same reason `demoMode` is: a
  // projection that omitted it would read as `undefined`, which this rule reads
  // as "off" — so omitting it would make every tenant look unconfigured and the
  // rule would appear to do nothing forever.
  passInactivityMonths: tenantWalletPrograms.passInactivityMonths,
  lastSyncedAt: tenantWalletPrograms.lastSyncedAt,
};

/**
 * A `WalletStore` bound to one database.
 *
 * The tenant is a parameter of every method rather than a field on the object.
 * A field would be set once in the route and then trusted by six queries, which
 * is exactly the shape of bug the parameter makes impossible.
 */
export function createDrizzleWalletStore(db: Db): WalletStore {
  return {
    async getIssuerId(): Promise<string> {
      const programRow = await db
        .select({ issuerId: tenantWalletPrograms.issuerId })
        .from(tenantWalletPrograms)
        .limit(1);
      return programRow[0]?.issuerId ?? '';
    },
    async findCustomer(globalId: string, tenantId: string): Promise<WalletCustomerRow | null> {
      const [row] = await db
        .select(CUSTOMER_COLUMNS)
        .from(customers)
        .where(
          and(
            eq(customers.globalId, globalId),
            eq(customers.businessId, tenantId),
            // A withdrawn membership must not keep obtaining passes. The same
            // exclusion `GET /v1/customers/me` and the growth worker's
            // ownership check apply, and for the same reason: it is the
            // difference between "no such person" and "not a member here".
            isNull(customers.deletedAt),
          ),
        )
        .limit(1);

      return (row as WalletCustomerRow | undefined) ?? null;
    },

    async findCustomerById(customerId: string, tenantId: string): Promise<WalletCustomerRow | null> {
      const [row] = await db
        .select(CUSTOMER_COLUMNS)
        .from(customers)
        .where(
          and(
            eq(customers.id, customerId),
            eq(customers.businessId, tenantId),
            isNull(customers.deletedAt),
          ),
        )
        .limit(1);

      return (row as WalletCustomerRow | undefined) ?? null;
    },

    async findProgram(tenantId: string): Promise<WalletProgramRow | null> {
      const [row] = await db
        .select(PROGRAM_COLUMNS)
        .from(tenantWalletPrograms)
        .where(eq(tenantWalletPrograms.tenantId, tenantId))
        .limit(1);

      return (row as WalletProgramRow | undefined) ?? null;
    },

    /**
     * The program row joined to the tenant's own name and slug.
     *
     * ## `PROGRAM_COLUMNS` plus two, and not a wider `PROGRAM_COLUMNS`
     *
     * The shared projection is deliberately left alone. It is also read by
     * `listProgramTenants`, the cross-tenant provisioning sweep, and a join in
     * there either drops program rows from provisioning (INNER) or widens a
     * bounded enumeration for no benefit (LEFT). The rationale is on the interface
     * method in `store.ts`; this is the same decision at the query.
     *
     * `LEFT JOIN` and the join predicate is `tenants.id = tenant_id`, so the
     * branding attaches to the row's own tenant and cannot be another merchant's
     * by construction. The predicate on the base table is still there: the join
     * decides *whose branding*, and the `where` decides *which program row*, and a
     * join must never be what scopes a tenant read.
     */
    async findProgramWithBusiness(tenantId: string): Promise<WalletProgramWithBusinessRow | null> {
      const [row] = await db
        .select({
          ...PROGRAM_COLUMNS,
          businessName: tenants.name,
          businessSlug: tenants.slug,
        })
        .from(tenantWalletPrograms)
        .leftJoin(tenants, eq(tenants.id, tenantWalletPrograms.tenantId))
        .where(eq(tenantWalletPrograms.tenantId, tenantId))
        .limit(1);

      return (row as WalletProgramWithBusinessRow | undefined) ?? null;
    },

    /**
     * Give a tenant its program row, and do nothing if it already has one.
     *
     * Raw SQL with explicit columns rather than a Drizzle `insert`, because two
     * of the six values are decisions this table makes badly by default:
     * `review_status` defaults to `'none'`, which means "no class yet" and fails
     * the readiness gate closed for a tenant that has one, and `demo_mode`
     * defaults to whatever the column was declared with. Both are written by the
     * caller as values, so a provisioning path that forgot one produces a failed
     * call rather than a plausible wrong row.
     *
     * `ON CONFLICT (tenant_id) DO NOTHING` rather than `DO UPDATE`: the class id
     * in the row is the record of what exists at Google, and a second
     * provisioning run overwriting it would replace the only evidence of what the
     * first run created.
     */
    async insertProgram(program: ProgramInsert): Promise<void> {
      await db.execute(sql`
        INSERT INTO tenant_wallet_programs (tenant_id, issuer_id, class_id, review_status, demo_mode)
        VALUES (
          ${program.tenantId}::uuid,
          ${program.issuerId},
          ${program.classId},
          ${program.reviewStatus},
          ${program.demoMode}
        )
        ON CONFLICT (tenant_id) DO NOTHING
      `);
    },

    /**
     * The tenant's own name and country.
     *
     * Scoped by `tenants.id`, which is the tenant — this is the one read here
     * whose predicate is the key itself, and the reason a branding row can never
     * belong to a merchant other than the one the caller asked for.
     */
    async findTenantBranding(tenantId: string): Promise<WalletTenantBrandingRow | null> {
      // `slug` is selected because the class's `homepageUri` is built from it and
      // it has to be the tenant's real slug rather than one derived from `name`.
      const [row] = await db
        .select({ name: tenants.name, country: tenants.country, slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      return (row as WalletTenantBrandingRow | undefined) ?? null;
    },

    /**
     * The tenant's program name.
     *
     * A blank name reads as absent, for the same reason a blank points currency
     * does: Google requires `programName`, and an empty one is a class whose card
     * shows no programme at all, which looks like our bug rather than like a
     * merchant who has not configured anything.
     */
    async findProgramName(tenantId: string): Promise<string | null> {
      const [row] = await db
        .select({ name: loyaltyPrograms.name })
        .from(loyaltyPrograms)
        .where(eq(loyaltyPrograms.businessId, tenantId))
        .limit(1);

      const name = (row as { name?: string } | undefined)?.name;
      if (name === undefined || name.trim() === '') return null;
      return name;
    },

    async findPointsCurrency(tenantId: string): Promise<string | null> {
      const [row] = await db
        .select({ pointsCurrency: loyaltyPrograms.pointsCurrency })
        .from(loyaltyPrograms)
        .where(eq(loyaltyPrograms.businessId, tenantId))
        .limit(1);

      const currency = (row as { pointsCurrency?: string } | undefined)?.pointsCurrency;
      // A blank currency is treated as absent rather than passed through: an
      // empty string on `loyaltyPoints.label` is a valid-looking pass that shows
      // a number with no unit, which is worse than refusing to build one.
      if (currency === undefined || currency.trim() === '') return null;
      return currency;
    },

    /**
     * The merchant's promo sentence, or `null` when they have written none.
     *
     * Blank is absent, for the reason `findProgramName` treats a blank name as
     * absent: the column has no default, so an empty string here is a value a
     * merchant can write by accident, and passing it on would render a promo
     * row with a header and nothing under it.
     */
    async findPromoCopy(tenantId: string): Promise<string | null> {
      const [row] = await db
        .select({ promoCopy: loyaltyPrograms.promoCopy })
        .from(loyaltyPrograms)
        .where(eq(loyaltyPrograms.businessId, tenantId))
        .limit(1);

      // Both spellings, and the `null` one is the load-bearing half: the column is
      // nullable, so a merchant who wrote none yields `null` rather than
      // `undefined`, and a `null.trim()` is a 500 on the signup path rather
      // than a class with no promo row.
      const promo = (row as { promoCopy?: string | null } | undefined)?.promoCopy;
      if (promo === undefined || promo === null || promo.trim() === '') return null;
      return promo;
    },

    async findTierName(tierId: string, tenantId: string): Promise<WalletTierRow | null> {
      const [row] = await db
        .select({ name: membershipTiers.name })
        .from(membershipTiers)
        .where(and(eq(membershipTiers.id, tierId), eq(membershipTiers.businessId, tenantId)))
        .limit(1);

      return (row as WalletTierRow | undefined) ?? null;
    },

    /**
     * The ledger's own balance.
     *
     * `balance_after` of the most recent transaction, by `created_at DESC` —
     * the same definition `GET /v1/customers/me` and the growth worker's redeem
     * path use. `COALESCE(..., 0)` because a member who has never earned holds
     * zero points, which is a balance, not a missing value.
     *
     * Scoped by `customer_id` **and** `business_id`. The customer id alone is
     * already tenant-unique in practice, but `points_transactions` is one of the
     * `business_id`-scoped RLS tables, so writing the filter keeps the
     * application predicate identical to the policy the database will apply.
     *
     * This is a single non-correlated ordered select rather than a correlated
     * subquery, deliberately: `workers/customer` records that the serverless
     * Drizzle driver mishandles correlated subqueries in `.select()` and
     * returns 0 instead of the real balance. A pass that silently reported
     * every member as holding nothing would be an incident at the till.
     */
    async latestBalance(customerId: string, tenantId: string): Promise<number> {
      const [row] = await db
        .select({ balanceAfter: pointsTransactions.balanceAfter })
        .from(pointsTransactions)
        .where(
          and(
            eq(pointsTransactions.customerId, customerId),
            eq(pointsTransactions.businessId, tenantId),
          ),
        )
        .orderBy(desc(pointsTransactions.createdAt))
        .limit(1);

      const balance = (row as { balanceAfter?: number | string } | undefined)?.balanceAfter;
      if (balance === undefined || balance === null) return 0;
      return Number(balance);
    },

    async isMemberCodeTaken(tenantId: string, code: string): Promise<boolean> {
      const [row] = await db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.businessId, tenantId), eq(customers.memberCode, code)))
        .limit(1);

      return row !== undefined;
    },

    /**
     * The compare-and-set.
     *
     * `WHERE member_code IS NULL` is the whole safety argument, and it is one
     * statement rather than a read followed by a write. Two concurrent first
     * pass requests for the same customer both derive a candidate and both find
     * it free; without the guard the second would overwrite the first, and the
     * two `accountId`s would disagree while only one object ever reached Google.
     *
     * `RETURNING member_code` gives the post-condition, so a caller that lost
     * the race learns the winner's value instead of assuming its own. A lost
     * race is therefore not an error — it is the design working.
     *
     * The partial unique index `uq_customers_business_member_code` is the
     * backstop for the case this cannot catch: two *different* customers
     * deriving the same code concurrently. Neither sees the other's uncommitted
     * row, one of the two updates raises 23505, and that surfaces as an error
     * rather than as a silently dropped write.
     */
    async claimMemberCode(
      customerId: string,
      tenantId: string,
      code: string,
    ): Promise<string | null> {
      const result = await db.execute(sql`
        UPDATE customers
           SET member_code = ${code}, updated_at = now()
         WHERE id = ${customerId}::uuid
           AND business_id = ${tenantId}::uuid
           AND member_code IS NULL
        RETURNING member_code
      `);

      const rows = (result as { rows?: Array<{ member_code?: string | null }> }).rows ?? [];
      const stored = rows[0]?.member_code;
      return typeof stored === 'string' && stored !== '' ? stored : null;
    },

    /**
     * Record the pass without ever asserting it was issued.
     *
     * `state` is absent from the `SET` clause by design, so this cannot move a
     * pass from `inactive` back to `not_issued`, nor invent an `issued`. The
     * `WHERE customer_wallet_passes.state = 'not_issued'` guard on the conflict
     * branch means an update can only refresh `object_id` while the pass has
     * never been issued at all — and `object_id` is derived from
     * `customers.global_id`, which never changes, so in practice the update is a
     * no-op that keeps the statement idempotent.
     *
     * Note that reconciliation moves the state on to `not_saved`, which this
     * guard does not list. That is deliberate and harmless: once a pass is
     * `not_saved` we have already issued it, so refreshing `object_id` is no
     * longer the only thing that could change, and the derivation is stable
     * enough that the branch remains a no-op.
     *
     * `last_synced_at` is left alone too. Nothing has been synced with Google.
     */
    async recordPass(update: PassTrackingUpdate): Promise<void> {
      await db.execute(sql`
        INSERT INTO customer_wallet_passes (customer_id, tenant_id, object_id, state)
        VALUES (
          ${update.customerId}::uuid,
          ${update.tenantId}::uuid,
          ${update.objectId},
          'not_issued'
        )
        ON CONFLICT (customer_id) DO UPDATE
           SET object_id = EXCLUDED.object_id,
               updated_at = now()
         WHERE customer_wallet_passes.state = 'not_issued'
      `);
    },

    async findPass(customerId: string, tenantId: string): Promise<WalletPassRow | null> {
      const [row] = await db
        .select({
          customerId: customerWalletPasses.customerId,
          tenantId: customerWalletPasses.tenantId,
          objectId: customerWalletPasses.objectId,
          state: customerWalletPasses.state,
          lastSyncedAt: customerWalletPasses.lastSyncedAt,
        })
        .from(customerWalletPasses)
        .where(
          and(
            eq(customerWalletPasses.customerId, customerId),
            // The second of the two tenant filters, and the one that matters
            // here: `customer_id` is the primary key, so the predicate already
            // narrows to a single row, and that row carries a `tenant_id` this
            // layer must still check. A row written against another tenant would
            // be patched at Google from this request.
            eq(customerWalletPasses.tenantId, tenantId),
          ),
        )
        .limit(1);

      return (row as WalletPassRow | undefined) ?? null;
    },

    /**
     * The write behind `reconcile.ts`, with the monotonicity guard in SQL.
     *
     * The states rank, weakest to strongest:
     *
     *     not_issued  ->  not_saved  ->  inactive  ->  issued
     *
     * and `expired` and `completed` are terminal — Google cannot un-expire an
     * object, and neither appears in the source set below, so nothing can move a
     * row off them.
     *
     * The guard is in the `WHERE`; the state assignment is wrapped in `CASE` so
     * that the guard covers **only the claim**, while `last_synced_at` is written
     * on every call where the row exists:
     *
     *     SET state = CASE WHEN <guard> THEN <written> ELSE state END,
     *         last_synced_at = <observedAt>
     *
     * That split is the point. `state` is a claim about the world and is
     * rank-guarded; `last_synced_at` is an observation of Google having answered
     * and is not. A guard that covered both meant a definitive answer about a
     * terminal row — one in `expired` or `completed`, which this worker itself
     * writes — matched nothing and was thrown away, leaving that pass permanently
     * in the sweep's due set and re-read on every run.
     *
     * Note what `CASE` makes unnecessary: the old
     * `OR state = <written>` idempotency clause. It only ever let a row be
     * re-asserted as the value it already held, which is a no-op on the row's
     * content, and it existed solely to stop `last_synced_at` freezing. The
     * timestamp now moves unconditionally, so the guard can be a pure rank
     * comparison with nothing incidental in it.
     *
     * `RETURNING customer_id` makes the effect observable. Under `Promise<void>`
     * a caller could not distinguish "the row is gone" from "the state was
     * refused", and both mean the pass will be due again next run.
     */
    async recordPassReconciliation(update: PassReconciliationUpdate): Promise<number> {
      const result = await db.execute(sql`
        UPDATE customer_wallet_passes
           SET state = CASE
                          WHEN state IN ('not_issued', 'not_saved', 'inactive')
                          THEN ${update.state}
                          ELSE state
                        END,
               last_synced_at = ${update.observedAt}::timestamptz,
               updated_at = now()
         WHERE customer_id = ${update.customerId}::uuid
           AND tenant_id = ${update.tenantId}::uuid
        RETURNING customer_id
      `);

      return countRows(result);
    },

    /**
     * The lifecycle write, with its own predicate.
     *
     * `state IN ('issued', 'inactive')` is the source set, not the target set,
     * and that is the whole safety argument: a lifecycle answer can only be
     * recorded against a row that **already asserts the object exists**. So a
     * lifecycle write can never make a pass claim an object Google does not
     * have, which is the one thing the existence guard was protecting.
     *
     * It also means `expired` and `completed` are terminal. Neither appears in
     * the source set, so no later observation can move a row off them — which
     * is correct, because Google cannot un-expire an object. `inactive` *is* in
     * the source set because a customer who reopens a deactivated pass really
     * does have an `ACTIVE` object again, and the existence path's strict
     * monotonicity would have forbidden recording that.
     *
     * This is the one write here that guards `last_synced_at` along with
     * `state`, and that is not an oversight: a zero-row result here is the
     * signal that our tracking state and Google's disagree — an object exists
     * for a pass we never confirmed exists. Stamping such a row would imply the
     * lifecycle claim was accepted, so the timestamp is left alone and the
     * caller is expected to call `recordPassObservation` instead, which stamps
     * without claiming. See the interface's return-value contract.
     */
    async recordPassLifecycle(update: PassLifecycleUpdate): Promise<number> {
      const result = await db.execute(sql`
        UPDATE customer_wallet_passes
           SET state = ${update.state},
               last_synced_at = ${update.observedAt}::timestamptz,
               updated_at = now()
         WHERE customer_id = ${update.customerId}::uuid
           AND tenant_id = ${update.tenantId}::uuid
           AND state IN ('issued', 'inactive')
        RETURNING customer_id
      `);

      return countRows(result);
    },

    /**
     * The observation, with no state written and no state predicate.
     *
     * `state` is absent from the `SET` clause and from the `WHERE`. Both are
     * load-bearing: adding the column would let a caller that has no word for
     * Google's answer invent one, and adding a state filter would reproduce the
     * permanent-due starvation this method was written to end, for whichever
     * states it excluded.
     *
     * The tenant filter is the third, and the reason the method is safe to call
     * from a scheduled sweep: it writes `last_synced_at` on rows it did not
     * verify the tenancy of, so the predicate has to carry `tenant_id` itself.
     */
    async recordPassObservation(update: PassObservationUpdate): Promise<number> {
      const result = await db.execute(sql`
        UPDATE customer_wallet_passes
           SET last_synced_at = ${update.observedAt}::timestamptz,
               updated_at = now()
         WHERE customer_id = ${update.customerId}::uuid
           AND tenant_id = ${update.tenantId}::uuid
        RETURNING customer_id
      `);

      return countRows(result);
    },

    /**
     * One page of tenants, ascending by primary key.
     *
     * Keyset, not `OFFSET`. `OFFSET n` re-reads and re-sorts the `n` rows it
     * skips, so the last page of a large sweep costs proportionally more than
     * the first, and a tenant inserted between two pages shifts every page after
     * it — silently skipping tenants rather than merely reordering them.
     * `tenant_id` is the primary key, so `>` is a total order and the cursor is
     * exact.
     *
     * The `limit` is interpolated rather than parameterised because it is a
     * validated integer from `sweep.ts` and Drizzle's `sql` template does not
     * accept a bare number in a `LIMIT` position without casting it. It is
     * clamped to `[1, 200]` here so a caller that passes something else cannot
     * produce an unbounded read even by accident.
     */
    async listProgramTenants(options: {
      limit: number;
      afterTenantId: string | null;
    }): Promise<WalletProgramRow[]> {
      const limit = Math.min(200, Math.max(1, Math.trunc(options.limit)));

      // `afterTenantId` is a uuid column compared against a uuid literal, and
      // a null start is expressed as a branch rather than as a sentinel string
      // so no tenant can be skipped by colliding with it.
      if (options.afterTenantId === null) {
        const rows = await db
          .select(PROGRAM_COLUMNS)
          .from(tenantWalletPrograms)
          .orderBy(asc(tenantWalletPrograms.tenantId))
          .limit(limit);
        return (rows as WalletProgramRow[]) ?? [];
      }

      const rows = await db
        .select(PROGRAM_COLUMNS)
        .from(tenantWalletPrograms)
        .where(gt(tenantWalletPrograms.tenantId, options.afterTenantId))
        .orderBy(asc(tenantWalletPrograms.tenantId))
        .limit(limit);

      return (rows as WalletProgramRow[]) ?? [];
    },

    /**
     * One page of tenants that have no program row, ascending by primary key.
     *
     * An anti-join, because the set being asked for is defined by absence: `LEFT
     * JOIN` the program table and keep the rows where its key is null. The
     * alternative — reading `tenants` and asking `findProgram` per tenant — is the
     * shape this method exists to avoid, because "has no row" is the one thing
     * `listProgramTenants` cannot express and a per-tenant probe would bring back
     * the N+1 this module's other enumerations were written without.
     *
     * Keyset, exactly as `listProgramTenants` is: `tenants.id` is a uuid primary
     * key, so `>` is an exact cursor, no `OFFSET` is involved, and a tenant
     * inserted between two pages shifts nothing. Clamped the same way too.
     *
     * The RLS note on `WalletStore.listTenantsWithoutProgram` applies to this
     * statement: it returns nothing once the tenant policies are enabled, and it
     * is meant to run on a bare session.
     */
    async listTenantsWithoutProgram(options: {
      limit: number;
      afterTenantId: string | null;
    }): Promise<string[]> {
      const limit = Math.min(200, Math.max(1, Math.trunc(options.limit)));

      const cursor =
        options.afterTenantId === null
          ? isNull(tenantWalletPrograms.tenantId)
          : and(isNull(tenantWalletPrograms.tenantId), gt(tenants.id, options.afterTenantId));

      const rows = await db
        .select({ tenantId: tenants.id })
        .from(tenants)
        .leftJoin(tenantWalletPrograms, eq(tenantWalletPrograms.tenantId, tenants.id))
        .where(cursor)
        .orderBy(asc(tenants.id))
        .limit(limit);

      return ((rows as Array<{ tenantId: string }>) ?? []).map((row) => row.tenantId);
    },

    /**
     * Resolve one page of Google object ids to our rows, within one tenant.
     *
     * `inArray` rather than N `eq` predicates so the statement stays one round
     * trip with one plan shape regardless of batch size, and the tenant filter
     * is present in the same `WHERE` as the id list so a row from another
     * tenant cannot be returned even if the id list were wrong.
     *
     * An empty `objectIds` short-circuits to `[]` without a query: `inArray`
     * with an empty array compiles to SQL that matches nothing, but issuing the
     * round trip at all on an empty Google page is pure waste.
     */
    async findPassesByObjectIds(objectIds: string[], tenantId: string): Promise<WalletPassRow[]> {
      if (objectIds.length === 0) return [];

      const rows = await db
        .select({
          customerId: customerWalletPasses.customerId,
          tenantId: customerWalletPasses.tenantId,
          objectId: customerWalletPasses.objectId,
          state: customerWalletPasses.state,
          lastSyncedAt: customerWalletPasses.lastSyncedAt,
        })
        .from(customerWalletPasses)
        .where(
          and(
            inArray(customerWalletPasses.objectId, objectIds),
            eq(customerWalletPasses.tenantId, tenantId),
          ),
        );

      return (rows as WalletPassRow[]) ?? [];
    },

    /**
     * The passes whose customer has not touched the ledger inside `cutoff`.
     *
     * ## The conditions, and why each one is here
     *
     * Four predicates, and dropping any of them is a specific failure:
     *
     *   1. `p.tenant_id = <tenantId>`. The crossing defence, same as every other
     *      statement in this file. The window is per tenant, so this is also what
     *      keeps one merchant's three months from deciding another merchant's
     *      twenty-four.
     *   2. `p.state = 'issued'`. Only a pass we believe Google holds, and only
     *      one that is not already in the target state. `not_issued` and
     *      `not_saved` have no object to patch and `patchObject` would 404;
     *      `inactive` is already done, so including it would re-deactivate on
     *      every run; `expired` and `completed` are Google's own terminal states
     *      and this rule does not get a vote on them. It also makes the rule
     *      idempotent for free.
     *   3. `COALESCE(t.last_activity_at, c.created_at) < <cutoff>`. **Strict.**
     *      A transaction landing exactly on the cutoff is activity, so the
     *      customer is not a candidate — see `isInactiveSince`, which this
     *      mirrors and which is where that boundary is actually tested. The
     *      `COALESCE` is the part that is easy to omit: without it a customer who
     *      has *never* transacted has no clock at all, and a
     *      `COALESCE(...)` that fell back to `now()` or to `NULL` would make
     *      every newly enrolled customer a candidate on day one.
     *   4. `LIMIT`, honoured rather than ignored. See the interface.
     *
     * ## Why the ledger read is a `LEFT JOIN LATERAL`
     *
     * `max(tx.created_at)` over the customer's own transactions. Written as a
     * lateral rather than as a correlated subquery in the `WHERE` because the
     * predicate needs the same value the projection returns: repeating the
     * subquery twice would be two expressions that have to agree, and they are
     * the one thing in this rule that decides whether a customer's card moves.
     *
     * The lateral is `LEFT JOIN ... ON true` on an aggregate, which always
     * produces exactly one row and therefore never drops a pass from the result —
     * the `LEFT` is what preserves the no-transactions customer.
     *
     * ## The index this uses, and why no new one was added
     *
     * `idx_points_balance (business_id, customer_id, created_at DESC)`. Both
     * equality predicates are its leading columns, and the `DESC` means the
     * newest transaction for that customer is the first entry the planner reaches,
     * so `max()` is satisfied by the first row it walks to. A customer with
     * recent activity is refuted immediately; a genuinely idle one walks the
     * customer's whole history, which is the rare case and the small one.
     *
     * The driving side is `customer_wallet_passes` narrowed by
     * `idx_customer_wallet_passes_tenant`, then one index probe per pass. That
     * is proportional to the size of the tenant, which is the size of the work,
     * and it runs once a day for tenants that asked for it and never for tenants
     * that did not.
     */
    async findInactivePassCandidates(input: {
      tenantId: string;
      cutoff: Date;
      limit: number;
    }): Promise<InactivityCandidateRow[]> {      const limit = Math.min(2000, Math.max(1, Math.trunc(input.limit)));

      const result = await db.execute(sql`
        SELECT p.customer_id,
               p.object_id,
               last_activity.last_activity_at
          FROM customer_wallet_passes p
          JOIN customers c
            ON c.id = p.customer_id
          LEFT JOIN LATERAL (
            SELECT max(tx.created_at) AS last_activity_at
              FROM points_transactions tx
             WHERE tx.business_id = p.tenant_id
               AND tx.customer_id = p.customer_id
          ) last_activity ON true
         WHERE p.tenant_id = ${input.tenantId}::uuid
           AND p.state = 'issued'
           AND COALESCE(last_activity.last_activity_at, c.created_at) < ${input.cutoff}::timestamptz
         ORDER BY p.customer_id
         LIMIT ${limit}
      `);

      const rows = (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];

      return rows.map((row) => ({
        customerId: String(row.customer_id),
        objectId: String(row.object_id),
        // `null` rather than `undefined` when the customer has never transacted.
        // The two are handled the same way by the rule, and normalising here
        // means the report can print it without a null check of its own.
        lastActivityAt:
          row.last_activity_at === null || row.last_activity_at === undefined
            ? null
            : new Date(row.last_activity_at as string),
      }));
    },

    /**
     * The consenting pass holders of one tenant, one keyset page at a time.
     *
     * ## Why a join and not two reads
     *
     * The fan-out needs "consented **and** has an issued pass", and the two
     * facts live in two tables. Reading the consents and then filtering passes in
     * JavaScript would pull a tenant's whole consent table across the wire to
     * discard most of it, and the keyset cursor would then be over a set the
     * database never ordered.
     *
     * ## Why the consent key is `customers.id`
     *
     * Because that is the key every reader of the consent uses. The identity
     * routes used to write `customers.global_id` here — the JWT subject — and
     * those rows are invisible to `readConsentMap`, to the communication worker
     * and to this query alike. A consent stored under a key nobody reads is not
     * a consent, it is a row.
     *
     * ## The cursor
     *
     * `customer_id` is the primary key of `customer_wallet_passes`, so it is
     * unique per page and stable under concurrent inserts. An `OFFSET` would
     * skip a customer when a row before it disappeared between calls.
     */
    async listConsentingPasses(input: {
      tenantId: string;
      after: string | null;
      limit: number;
    }): Promise<ConsentingPassRow[]> {
      const limit = Math.min(500, Math.max(1, Math.trunc(input.limit)));

      const result = await db.execute(sql`
        SELECT p.customer_id,
               p.object_id
          FROM customer_wallet_passes p
          JOIN consents c
            ON c.business_id = p.tenant_id
           AND c.customer_id = p.customer_id
           AND c.consent_type = 'nearby_notifications'
           AND c.granted = true
         WHERE p.tenant_id = ${input.tenantId}::uuid
           AND p.state = 'issued'
           AND (${input.after}::uuid IS NULL OR p.customer_id > ${input.after}::uuid)
         ORDER BY p.customer_id
         LIMIT ${limit}
      `);

      const rows = (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];

      return rows.map((row) => ({
        customerId: String(row.customer_id),
        objectId: String(row.object_id),
      }));
    },

    async countNotifyingDeliveries(input: {
      tenantId: string;
      objectId: string;
      since: Date;
    }): Promise<number> {
      const result = await db.execute(sql`
        SELECT count(*)::int AS n
          FROM wallet_message_deliveries d
          JOIN wallet_messages m ON m.id = d.message_id
         WHERE m.business_id = ${input.tenantId}::uuid
           AND d.object_id = ${input.objectId}
           AND d.mode = 'notify'
           AND d.delivered_at IS NOT NULL
           AND d.delivered_at >= ${input.since}::timestamptz
      `);

      const rows = (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
      const n = rows[0]?.n;
      return typeof n === 'number' ? n : Number(n ?? 0);
    },


    async updateProgramReviewStatus(
      tenantId: string,
      reviewStatus: string,
      syncedAt: Date,
    ): Promise<void> {
      await db
        .update(tenantWalletPrograms)
        .set({ reviewStatus, lastSyncedAt: syncedAt, updatedAt: syncedAt })
        .where(eq(tenantWalletPrograms.tenantId, tenantId));
    },

    async setProgramDemoMode(tenantId: string, demoMode: boolean): Promise<number> {
      // The tenant filter is the whole point of this statement: it is a write
      // reachable from an operator request, and without it a bad id would edit a
      // row belonging to someone else. `RETURNING` reports whether a row actually
      // matched, so a caller can distinguish "set" from "no such tenant".
      const result = await db.execute(sql`
        UPDATE tenant_wallet_programs
           SET demo_mode = ${demoMode},
               updated_at = now()
         WHERE tenant_id = ${tenantId}::uuid
        RETURNING tenant_id
      `);

      return countRows(result);
    },

    /**
     * `class_id` → `tenant_id`, and the only cross-tenant read on the callback
     * path.
     *
     * ## Why the column is compared rather than derived
     *
     * The obvious shortcut is to parse the tenant out of `<issuerId>.tenant-<id>`
     * with the same helper `ids.ts` uses. It is not used, and the reason is that
     * the program row is the *authority* on which tenant owns which class — the
     * same reason every other read in this worker prefers
     * `tenant_wallet_programs` over a re-derivation. A class whose stored
     * `class_id` disagrees with the formula would be resolved by the formula to a
     * tenant that does not own it, and the callback would then write that
     * tenant's rows. Reading the row cannot have that failure mode: a class id
     * that is not in the table resolves to `null` and is refused.
     *
     * ## No session variable
     *
     * There is no tenant to scope to — establishing which tenant a class belongs
     * to *is* the question — so this runs on a session with no
     * `app.current_tenant_id`, like `listProgramTenants`. It inherits that
     * method's documented consequence: no rows at all once tenant RLS is
     * enabled, until these cross-tenant queries are given a bypass role.
     *
     * ## The parameter is a value, never concatenated
     *
     * Drizzle binds it. A `classId` from a request body is attacker-influenced
     * text, and the only reason it is safe here is that it becomes a bound
     * parameter rather than SQL.
     */
    async findTenantByClassId(classId: string): Promise<WalletTenantByClassIdRow | null> {
      const rows = await db
        .select({ tenantId: tenantWalletPrograms.tenantId })
        .from(tenantWalletPrograms)
        .where(eq(tenantWalletPrograms.classId, classId))
        .limit(1);

      return (rows[0] as WalletTenantByClassIdRow | undefined) ?? null;
    },

    /**
     * `INSERT ... ON CONFLICT DO NOTHING RETURNING`, which is the dedupe.
     *
     * The whole guarantee is that the check and the record are one statement, so
     * two concurrent deliveries of the same nonce cannot both observe absence.
     * A read-then-write has a window between the two, and Google's retries land
     * inside windows like that.
     *
     * `RETURNING` is what makes the answer observable: one row means this call
     * created the record and owns the effect, zero means the unique index
     * rejected it and the delivery is a replay. Under `Promise<void>` the caller
     * could not tell "already seen" from "written", which is the difference
     * between a duplicate apply and a correct no-op.
     */
    async claimCallbackDelivery(claim: PassCallbackClaim): Promise<boolean> {
      const result = await db.execute(sql`
        INSERT INTO wallet_callback_deliveries (tenant_id, nonce, event_type, received_at)
        VALUES (${claim.tenantId}::uuid, ${claim.nonce}, ${claim.eventType}, now())
        ON CONFLICT ON CONSTRAINT uq_wallet_callback_deliveries_tenant_nonce DO NOTHING
        RETURNING id
      `);

      return countRows(result) > 0;
    },

    /**
     * The callback write, with a source set the existence guard does not have.
     *
     * `state IN ('issued', 'inactive', 'not_saved', 'not_issued')` is every state
     * that does not claim a terminal lifecycle, and it is the *source* set. The
     * consequence is the one the whole feature depends on: `del` can move a row
     * from `issued` back to `not_saved`, which `recordPassReconciliation`'s rank
     * guard would refuse.
     *
     * The states that stay put are `expired` and `completed`, by omission. Google
     * cannot un-expire or un-complete an object, so a `save` delivered late for a
     * pass that has since expired must not resurrect it to `issued` — and this
     * predicate is what stops that.
     *
     * `inactive` is in the set precisely so it *can* move to `issued`: a customer
     * who reactivates a pass has it in their phone, and the existence path's
     * strict monotonicity would have forbidden recording that truth.
     */
    async recordPassCallback(update: PassCallbackWrite, observedAt: Date): Promise<number> {
      const state = update.eventType === 'save' ? 'issued' : 'not_saved';

      const result = await db.execute(sql`
        UPDATE customer_wallet_passes
           SET state = ${state},
               last_synced_at = ${observedAt}::timestamptz,
               updated_at = now()
         WHERE customer_id = ${update.customerId}::uuid
           AND tenant_id = ${update.tenantId}::uuid
           AND state IN ('not_issued', 'not_saved', 'inactive', 'issued')
        RETURNING customer_id
      `);

      return countRows(result);
    },
  };
}
