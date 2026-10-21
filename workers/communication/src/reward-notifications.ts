import { createDb, branches, customers, messageLog } from '@vyloop/db';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';

import type { Bindings } from './helpers';
import { withRls } from './helpers';
import { deliverPushNotification } from './push-delivery';

// ---------------------------------------------------------------------------
// Telling a customer that a reward is redeemable somewhere.
//
// ## Why this is not part of the grant
//
// The growth worker grants a reward the moment a balance crosses a threshold.
// Most of those grants are good at every venue, and saying "you have a prize"
// to a customer who already knows is noise. This module only runs for the
// grants that are scoped to particular venues, where the useful sentence is
// "your prize is *here*".
//
// ## The two gates
//
// Consent and a registered browser, both checked by `deliverPushNotification`
// at the moment of delivery rather than here — a gate that only runs when the
// event is produced stops working the day the customer withdraws.
//
// ## The frequency cap
//
// At most one reward push per customer per business in a day. A customer whose
// balance crosses three thresholds in one purchase has earned three rewards
// and does not need three notifications: the app shows all three, and the cap
// decides which one gets announced. A capped grant is **acked, not retried**:
// the message is not owed, it is skipped on purpose.
// ---------------------------------------------------------------------------

/**
 * How long after one reward push another is suppressed.
 *
 * A day, from the product decision on `branch-reward-trigger` Q3: the same
 * customer in the same business is announced at most once per day, and any
 * further grant in that window is acknowledged without a delivery.
 */
export const REWARD_PUSH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The prefix that marks a `message_log` row as a reward announcement.
 *
 * The row also carries the per-subscription suffix `deliverPushNotification`
 * appends, so the cap is matched on the prefix rather than on the whole
 * reference.
 */
export const REWARD_REFERENCE_PREFIX = 'reward-grant:';

/** The payload of a `RewardAvailableAtBranch` event. */
export interface RewardAvailableAtBranchPayload {
  /** The **global** id: what a push delivery resolves. */
  customer_id: string;
  reward_id: string;
  reward_name: string;
  grant_id: string;
  branch_ids: string[];
  granted_at: string;
}

/** What an announcement did, so the queue's log says something useful. */
export interface RewardAnnouncementOutcome {
  /** `sent`, `capped`, `no_customer` or `not_delivered`. */
  result: 'sent' | 'capped' | 'no_customer' | 'not_delivered';
  /** How many browsers the message reached. */
  delivered: number;
}

/**
 * Whether this customer was already told about a reward today.
 *
 * Read from `message_log`, which is where every push delivery leaves a row:
 * a separate counter table would be a second source of truth for something the
 * delivery already records, and the two would disagree the first time a row
 * was cleaned up.
 *
 * The window is the message's age, not the grant's, because what is being
 * limited is how often the customer is interrupted.
 */
export async function wasRewardAnnouncedToday(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  businessId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const since = new Date(now.getTime() - REWARD_PUSH_WINDOW_MS);

  const [row] = await db
    .select({ id: messageLog.id })
    .from(messageLog)
    .where(
      and(
        eq(messageLog.businessId, businessId),
        eq(messageLog.customerId, customerId),
        eq(messageLog.channel, 'push'),
        gte(messageLog.createdAt, since),
        sql`${messageLog.content}->>'reference_id' LIKE ${`${REWARD_REFERENCE_PREFIX}%`}`,
      ),
    )
    .limit(1);

  return Boolean(row);
}

/**
 * The sentence that names where the reward is good.
 *
 * Q5 of the change: name the venue when the reward is scoped to exactly one,
 * and the count otherwise. Naming one venue out of several would send the
 * customer to the wrong place — redemption is not restricted to the venues the
 * reward is scoped to (Q4), so the venue is an example of where it is offered,
 * not a condition of using it.
 */
export function describeRewardVenues(venueNames: string[], venueCount: number): string {
  if (venueCount === 1 && venueNames.length === 1) {
    return `en ${venueNames[0]}`;
  }
  return `en ${venueCount} locales`;
}

/**
 * Announce a venue-scoped reward to the customer who was granted it.
 *
 * Throws only what `deliverPushNotification` throws, which is the retryable
 * case (a `429`, or a network failure while sending). Everything decided
 * locally — no customer, capped, no browser — is a logged ack.
 */
export async function handleRewardAvailableAtBranch(
  payload: RewardAvailableAtBranchPayload,
  businessId: string,
  env: Bindings,
): Promise<RewardAnnouncementOutcome> {
  const db = createDb(env.DATABASE_URL);
  await withRls(db, businessId);

  // The internal id is needed for the cap and for the venue lookup's tenant
  // filter; the delivery resolves the customer again by the global id.
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.businessId, businessId),
        eq(customers.globalId, payload.customer_id),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);

  if (!customer) {
    console.warn(
      `[communication] Reward announcement for unknown customer ${payload.customer_id} — acking`,
    );
    return { result: 'no_customer', delivered: 0 };
  }

  if (await wasRewardAnnouncedToday(db, businessId, customer.id)) {
    console.log(
      `[communication] Customer ${payload.customer_id} was already told about a reward today — ` +
        `acknowledging grant ${payload.grant_id} without a delivery`,
    );
    return { result: 'capped', delivered: 0 };
  }

  // The venue names, filtered to this tenant for the same reason every other
  // read is: the ids came from an event, and an event is data.
  const venues = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(
      and(
        eq(branches.businessId, businessId),
        inArray(branches.id, payload.branch_ids),
      ),
    );

  const where = describeRewardVenues(
    venues.map((venue: { name: string }) => venue.name),
    payload.branch_ids.length,
  );

  // No balance, no points, no customer name: a push body can be read by
  // whoever is holding the phone, and the reward's name is the whole message.
  const title = `Tenés "${payload.reward_name}"`;
  const body = `Ya podés canjearla ${where}.`;

  const outcome = await deliverPushNotification(
    {
      customer_id: payload.customer_id,
      business_id: businessId,
      title,
      body,
      url: '/profile/rewards',
      reference_id: `${REWARD_REFERENCE_PREFIX}${payload.grant_id}`,
    },
    businessId,
    env,
  );

  return {
    result: outcome.delivered > 0 ? 'sent' : 'not_delivered',
    delivered: outcome.delivered,
  };
}
