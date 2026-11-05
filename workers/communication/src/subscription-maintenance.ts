import { createDb, customers, pushSubscriptions, tenants, withTenantTransaction } from '@vyloop/db';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type { Bindings } from './helpers';

// ---------------------------------------------------------------------------
// The subscription sweep.
//
// A push subscription is a browser's registration with a push service. It is
// personal data, it is tied to a customer, and the table it lives in only ever
// grows: a browser is uninstalled, its site data is cleared, its subscription
// is revoked, and the row survives all of it. So the table needs a lifecycle,
// and this is it.
//
// ## What is pruned, and why
//
// Three rules, and each of them is a fact about the row:
//
//   - **Nobody has seen it for a long time.** A registration that has not been
//     delivered to in six months is a registration that has been unreachable
//     for six months.
//   - **It has never been seen, and it is old.** A subscription that was
//     created and never delivered to is stale too — but only once it is old
//     enough. A recent subscription with no `last_seen_at` has simply not had
//     the chance to be delivered to yet, and pruning it would delete a
//     registration that was made moments ago.
//   - **Its customer was deleted.** Deleting a customer in this platform is an
//     `UPDATE` of `deleted_at`, not a `DELETE`, so the `ON DELETE CASCADE` on
//     `push_subscriptions.customer_id` never fires. The subscription of a
//     customer who asked to be forgotten survives them, and that is exactly the
//     row that must not.
//
// ## Never throws
//
// A cron that throws has the whole invocation retried, so a sweep that throws
// on one broken row re-runs everything — and the second run re-prunes what the
// first run already pruned. Each sub-task therefore captures its own failure
// and the sweep carries on, and the counts it reports say what happened.
//
// ## One tenant at a time
//
// `push_subscriptions` and `customers` are tenant tables: under row-level
// security their policy reads `current_setting('app.current_business_id')`
// with no default, so a statement issued with no tenant set does not see
// nothing — it errors. The sweep therefore enumerates `tenants` (exempt from
// RLS) by keyset, and runs each step of each tenant inside its own
// `withTenantTransaction`. Every statement also carries the tenant in its own
// `WHERE`, so the session is the second line of defence, not the only one.
//
// One transaction per step, not per tenant: a failed statement aborts the
// transaction it runs in, so the second step needs a transaction of its own to
// run after the first one failed. A failure is reported with its tenant id and
// the next step, and the next tenant, still run.
// ---------------------------------------------------------------------------

/**
 * How long a subscription may go unseen before it is a candidate for pruning.
 *
 * One hundred and eighty days. Long enough that a customer who opens the app
 * once a season is still reachable, and short enough that the table does not
 * keep every browser anyone ever registered.
 */
export const STALE_SUBSCRIPTION_DAYS = 180;

/**
 * The most rows one step of one run deletes for one tenant.
 *
 * A sweep that deletes everything due in one statement holds its locks for as
 * long as that takes, and the first run after a backlog — or after a bug that
 * stopped `last_seen_at` from moving — would be the longest. A run that stops
 * at a batch leaves the rest for the next day, and the daily cron drains any
 * backlog a thousand rows at a time.
 */
export const SWEEP_BATCH_SIZE = 1000;

/**
 * How many tenants one page of the enumeration reads.
 *
 * Keyset on the primary key, so a page costs the same wherever it starts and a
 * tenant created mid-run shifts nothing.
 */
export const TENANT_PAGE_SIZE = 100;

/** The milliseconds in a day, so the window is written in days and computed once. */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Prune the subscriptions that are no longer worth keeping, tenant by tenant.
 *
 * Never throws. The counts are the report, and they are logged in one line:
 * the totals, the deletions of every tenant that had any, and the ids of the
 * tenants that failed.
 */
export async function handleSubscriptionMaintenance(env: Bindings): Promise<void> {
  let prunedStale = 0;
  let prunedDeletedCustomer = 0;
  let errors = 0;
  const pruned: string[] = [];
  const failedTenants = new Set<string>();

  try {
    const db = createDb(env.DATABASE_URL);

    // The window, computed once: both halves of the staleness rule, in every
    // tenant, compare against the same moment.
    const cutoff = new Date(Date.now() - STALE_SUBSCRIPTION_DAYS * MILLISECONDS_PER_DAY);

    let after: string | null = null;
    for (;;) {
      // `tenants` is exempt from RLS, so this read needs no tenant set.
      const page: Array<{ id: string }> = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(after === null ? undefined : gt(tenants.id, after))
        .orderBy(asc(tenants.id))
        .limit(TENANT_PAGE_SIZE);

      for (const { id: tenantId } of page) {
        const stale = await pruneStep(tenantId, 'stale push subscriptions', () =>
          withTenantTransaction(db, { businessId: tenantId }, (tx) => pruneStale(tx, tenantId, cutoff)),
        );
        const deletedCustomer = await pruneStep(
          tenantId,
          'push subscriptions of deleted customers',
          () =>
            withTenantTransaction(db, { businessId: tenantId }, (tx) =>
              pruneDeletedCustomers(tx, tenantId),
            ),
        );

        if (stale === null || deletedCustomer === null) {
          errors += (stale === null ? 1 : 0) + (deletedCustomer === null ? 1 : 0);
          failedTenants.add(tenantId);
        }
        prunedStale += stale ?? 0;
        prunedDeletedCustomer += deletedCustomer ?? 0;
        if ((stale ?? 0) + (deletedCustomer ?? 0) > 0) {
          pruned.push(`${tenantId}:stale=${stale ?? 0},deleted_customer=${deletedCustomer ?? 0}`);
        }
      }

      if (page.length < TENANT_PAGE_SIZE) break;
      after = page[page.length - 1]!.id;
    }
  } catch (error) {
    // The sweep could not enumerate tenants: the connection, the pool, the
    // deploy. The counts are still reported, because a run that reported
    // nothing is a run nobody can tell from a run that never happened.
    errors += 1;
    console.error(
      '[communication] The subscription sweep did not run:',
      error instanceof Error ? error.message : error,
    );
  }

  console.log(
    `[communication] Subscription maintenance: pruned_stale=${prunedStale} ` +
      `pruned_deleted_customer=${prunedDeletedCustomer} errors=${errors}` +
      (pruned.length > 0 ? ` pruned_by_tenant=${pruned.join(';')}` : '') +
      (failedTenants.size > 0 ? ` failed_tenants=${[...failedTenants].join(',')}` : ''),
  );
}

/**
 * Run one step for one tenant, and turn a failure into `null` and a log line
 * that names the tenant.
 */
async function pruneStep(
  tenantId: string,
  what: string,
  step: () => Promise<number>,
): Promise<number | null> {
  try {
    return await step();
  } catch (error) {
    console.error(
      `[communication] Could not prune the ${what} of tenant ${tenantId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** The handle `withTenantTransaction` gives the steps: the tenant is set on it. */
type TenantTx = Pick<ReturnType<typeof createDb>, 'select' | 'delete'>;

/** Delete one batch of the tenant's stale subscriptions; answer how many. */
async function pruneStale(tx: TenantTx, tenantId: string, cutoff: Date): Promise<number> {
  const stale = and(
    eq(pushSubscriptions.businessId, tenantId),
    or(
      // Seen, but not for a long time.
      lt(pushSubscriptions.lastSeenAt, cutoff),
      // Never seen, and old enough that it never will be.
      and(isNull(pushSubscriptions.lastSeenAt), lt(pushSubscriptions.createdAt, cutoff)),
    ),
  );

  const removed = await tx
    .delete(pushSubscriptions)
    .where(oneBatchOf(stale))
    .returning({ id: pushSubscriptions.id });

  return removed.length;
}

/** Delete one batch of the subscriptions of the tenant's deleted customers. */
async function pruneDeletedCustomers(tx: TenantTx, tenantId: string): Promise<number> {
  // The soft-deleted customers, as a subquery, so the delete is one statement
  // and cannot race with a customer deleted between the read and the write.
  // It reads `customers` on the same transaction, so it sees this tenant's
  // rows under RLS — a missing tenant would make it error, not come back empty.
  const deletedCustomers = tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.businessId, tenantId), isNotNull(customers.deletedAt)));

  const removed = await tx
    .delete(pushSubscriptions)
    .where(
      oneBatchOf(
        and(
          eq(pushSubscriptions.businessId, tenantId),
          inArray(pushSubscriptions.customerId, deletedCustomers),
        ),
      ),
    )
    .returning({ id: pushSubscriptions.id });

  return removed.length;
}

/**
 * The rows matching `predicate`, at most one batch of them, as a predicate on
 * the subscription id: Postgres has no `DELETE … LIMIT`.
 */
function oneBatchOf(predicate: SQL | undefined): SQL {
  return sql`${pushSubscriptions.id} in (select ${pushSubscriptions.id} from ${pushSubscriptions} where ${predicate} limit ${SWEEP_BATCH_SIZE})`;
}
