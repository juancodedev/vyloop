import { createDb, customers, pushSubscriptions } from '@vyloop/db';
import { and, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';

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
// ## No tenant session
//
// The sweep is table-wide: it runs across every tenant at once, the same way
// the wallet's own ageing sweep does. Opening a tenant session here would set
// `app.current_business_id` and hide every other tenant's rows from the sweep
// itself, so there is no session to open — and every statement below carries
// its own scope in its own `WHERE`.
// ---------------------------------------------------------------------------

/**
 * How long a subscription may go unseen before it is a candidate for pruning.
 *
 * One hundred and eighty days. Long enough that a customer who opens the app
 * once a season is still reachable, and short enough that the table does not
 * keep every browser anyone ever registered.
 */
export const STALE_SUBSCRIPTION_DAYS = 180;

/** The milliseconds in a day, so the window is written in days and computed once. */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Prune the subscriptions that are no longer worth keeping.
 *
 * Never throws. The counts are the report, and they are logged in one line.
 */
export async function handleSubscriptionMaintenance(env: Bindings): Promise<void> {
  let prunedStale = 0;
  let prunedDeletedCustomer = 0;
  let errors = 0;

  try {
    const db = createDb(env.DATABASE_URL);

    // The window, computed once: both halves of the staleness rule compare
    // against the same moment.
    const cutoff = new Date(Date.now() - STALE_SUBSCRIPTION_DAYS * MILLISECONDS_PER_DAY);

    // -----------------------------------------------------------------------
    // The stale subscriptions
    // -----------------------------------------------------------------------
    try {
      const removed = await db
        .delete(pushSubscriptions)
        .where(
          or(
            // Seen, but not for a long time.
            lt(pushSubscriptions.lastSeenAt, cutoff),
            // Never seen, and old enough that it never will be.
            and(
              isNull(pushSubscriptions.lastSeenAt),
              lt(pushSubscriptions.createdAt, cutoff),
            ),
          ),
        )
        .returning({ id: pushSubscriptions.id });

      prunedStale = removed.length;
    } catch (error) {
      errors += 1;
      console.error(
        '[communication] Could not prune the stale push subscriptions:',
        error instanceof Error ? error.message : error,
      );
    }

    // -----------------------------------------------------------------------
    // The subscriptions of a deleted customer
    // -----------------------------------------------------------------------
    try {
      // The soft-deleted customers, as a subquery, so the delete is one
      // statement and cannot race with a customer deleted between the read
      // and the write.
      const deletedCustomers = db
        .select({ id: customers.id })
        .from(customers)
        .where(isNotNull(customers.deletedAt));

      const removed = await db
        .delete(pushSubscriptions)
        .where(inArray(pushSubscriptions.customerId, deletedCustomers))
        .returning({ id: pushSubscriptions.id });

      prunedDeletedCustomer = removed.length;
    } catch (error) {
      errors += 1;
      console.error(
        '[communication] Could not prune the push subscriptions of deleted customers:',
        error instanceof Error ? error.message : error,
      );
    }
  } catch (error) {
    // The sweep could not even start: the connection, the pool, the deploy.
    // The counts are still reported, because a run that reported nothing is a
    // run nobody can tell from a run that never happened.
    errors += 1;
    console.error(
      '[communication] The subscription sweep did not run:',
      error instanceof Error ? error.message : error,
    );
  }

  console.log(
    `[communication] Subscription maintenance: pruned_stale=${prunedStale} ` +
      `pruned_deleted_customer=${prunedDeletedCustomer} errors=${errors}`,
  );
}
