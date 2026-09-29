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
  loyaltyPrograms,
  membershipTiers,
  pointsTransactions,
  setCurrentBusinessId,
  setCurrentTenantId,
  tenantWalletPrograms,
} from '@vyloop/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type {
  PassTrackingUpdate,
  WalletCustomerRow,
  WalletProgramRow,
  WalletStore,
  WalletTierRow,
} from './store';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

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
  };
}
