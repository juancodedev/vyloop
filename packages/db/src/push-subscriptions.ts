import { and, eq } from 'drizzle-orm';

import { pushSubscriptions } from './schema';

// ---------------------------------------------------------------------------
// Push subscriptions.
//
// A subscription is a browser's registration with a push service: an endpoint
// URL, the browser's public key, and an auth secret. The endpoint is a
// capability — anyone holding it can push to that browser — so it is treated
// as a secret everywhere except in this table, where it has to be stored to
// be used.
//
// The only sanctioned way to read and write it is through these helpers, for
// the same reason the consent helpers exist: one implementation of "which
// browsers can this customer be reached on" beats three.
// ---------------------------------------------------------------------------

/** A subscription, as the database holds it. */
export interface PushSubscriptionRecord {
  id: string;
  businessId: string;
  customerId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
}

/** Which customer, in which business. */
export interface PushSubscriptionScope {
  businessId: string;
  customerId: string;
}

/**
 * A digest of a push endpoint.
 *
 * The endpoint is a capability, and `message_log` is the table most likely to
 * be exported, displayed or shipped to a dashboard. A digest is enough to
 * answer "which deliveries went to this subscription?" for a support question,
 * and useless to anyone who reads the row.
 */
export async function hashPushEndpoint(endpoint: string): Promise<string> {
  const bytes = new TextEncoder().encode(endpoint);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Every subscription a customer holds, in this business.
 *
 * A customer may hold several: a phone and a laptop, or one browser with two
 * accounts, or the same browser in a normal and a private window. Each is a
 * separate registration and each has to be pushed to.
 */
export async function readPushSubscriptions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  scope: PushSubscriptionScope,
): Promise<PushSubscriptionRecord[]> {
  const rows = await db
    .select()
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.businessId, scope.businessId),
        eq(pushSubscriptions.customerId, scope.customerId),
      ),
    );

  return rows as PushSubscriptionRecord[];
}

/**
 * Register a subscription, or refresh the one already at that endpoint.
 *
 * A browser rotates its `p256dh` and `auth` for the same endpoint, so
 * registering again is not a duplicate: it is the same registration with newer
 * keys. The unique index on the endpoint is what makes that a single row, and
 * the upsert is what makes it not lose the new keys.
 */
export async function upsertPushSubscription(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: PushSubscriptionScope & {
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
  },
): Promise<PushSubscriptionRecord> {
  const now = new Date();

  const rows = await db
    .insert(pushSubscriptions)
    .values({
      businessId: input.businessId,
      customerId: input.customerId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        // The registration belongs to whoever holds the token now. A customer
        // who signed out and a different one who signed in on the same browser
        // would otherwise keep pushing to each other.
        customerId: input.customerId,
        businessId: input.businessId,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
        lastSeenAt: now,
      },
    })
    .returning();

  const row = (rows as PushSubscriptionRecord[])[0];
  if (!row) {
    throw new Error('The push subscription was not recorded.');
  }
  return row;
}

/**
 * Remove one subscription.
 *
 * Scoped by the business as well as the endpoint, so a subscription belonging
 * to another tenant cannot be removed by guessing its endpoint.
 *
 * Returns whether a row was actually removed, so a caller can answer "not
 * subscribed" separately from "removed".
 */
export async function deletePushSubscription(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: { businessId: string; endpoint: string },
): Promise<boolean> {
  const rows = await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.businessId, input.businessId),
        eq(pushSubscriptions.endpoint, input.endpoint),
      ),
    )
    .returning({ id: pushSubscriptions.id });

  return (rows as unknown[]).length > 0;
}

/**
 * Every subscription belonging to a business.
 *
 * This is the delivery list: a business pushes to every browser its customers
 * registered, because a customer with a phone and a laptop is two deliveries.
 */
export async function readBusinessPushSubscriptions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  businessId: string,
): Promise<PushSubscriptionRecord[]> {
  const rows = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.businessId, businessId));

  return rows as PushSubscriptionRecord[];
}

/**
 * Remove a subscription by endpoint alone, with no tenant in the predicate.
 *
 * For the delivery path only. A push service answers `404` or `410` for a
 * registration it no longer holds, and that answer is about the endpoint, not
 * about a tenant: there is no tenant in it to check. The subscription is
 * identified by the very capability that was rejected, so the check would be
 * vacuous.
 */
export async function deletePushSubscriptionByEndpoint(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  endpoint: string,
): Promise<boolean> {
  const rows = await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .returning({ id: pushSubscriptions.id });

  return (rows as unknown[]).length > 0;
}
