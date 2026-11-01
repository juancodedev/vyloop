import {
  createDb,
  customers,
  deletePushSubscriptionByEndpoint,
  hashPushEndpoint,
  messageLog,
  pushSubscriptions,
  readConsentMap,
  readPushSubscriptions,
  withTenantTransaction,
} from '@vyloop/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Bindings } from './helpers';
import { buildVapidAuthorization, encryptPushPayload } from './push-encryption';

// ---------------------------------------------------------------------------
// Delivering a push notification.
//
// A push message is delivered once per browser the customer registered, and
// each browser is a separate delivery with its own outcome. So this is not one
// message with a status: it is N messages, and the interesting part is what
// happens when the push service says no.
//
// ## The consent is checked again, here
//
// The subscription was gated on the consent when it was registered. A customer
// who withdraws afterwards must stop receiving messages, and the only moment
// that can be honoured is the moment of the delivery. A gate that only runs at
// registration is a gate that stops working the day it matters.
//
// ## What the push service says, and what it means
//
//   - **201**: delivered.
//   - **404 / 410**: the push service no longer holds that registration. The
//     browser was uninstalled, the site data was cleared, or the subscription
//     was revoked. The subscription is dead and is removed, because leaving it
//     means every future message pays for a delivery that cannot happen.
//   - **429**: the service is asking us to slow down. The message stays queued
//     and the queue retries it.
//   - **401 / 403**: the VAPID key is not accepted. Retrying will not fix a key
//     that is wrong, so it is terminal.
//   - **400**: the body was rejected. Also terminal, and also a bug on our side
//     rather than something a retry can cure.
//
// The endpoint is a capability and it never appears in a log. What is written
// instead is a digest of it, so a support question can be answered without
// the row handing out a way to push at a customer's browser.
// ---------------------------------------------------------------------------

/** The consent a push message requires. */
const PUSH_CONSENT_TYPE = 'nearby_notifications';

/** The payload of a `PushNotificationRequested` event. */
export interface PushNotificationPayload {
  customer_id: string;
  business_id: string;
  title: string;
  body: string;
  url?: string;
  /** A key that identifies the message, so the same one is not delivered twice. */
  reference_id?: string;
  /** Campaign-level fields persisted so campaigns can be listed/read back. */
  target?: unknown;
  target_type?: 'branch' | 'radius';
  audience_size?: number;
}

export interface PushDeliveryOutcome {
  /** How many browsers the message reached. */
  delivered: number;
  /** How many deliveries failed for good. */
  failed: number;
  /** How many dead subscriptions were removed. */
  removed: number;
  /** How many browsers the customer had, before and after. */
  subscriptions: number;
}

/** The outcome of one delivery attempt. */
type Attempt =
  | { kind: 'delivered' }
  | { kind: 'dead' }
  | { kind: 'retry' }
  | { kind: 'terminal'; reason: string };

/**
 * Deliver one message to one browser.
 *
 * The classification is separate from the sending so it can be tested without
 * a push service.
 */
export async function attemptDelivery(
  endpoint: string,
  body: Uint8Array,
  headers: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<Attempt> {
  // A network error is not the service saying no, and it is deliberately not
  // caught: it travels up so the queue retries the delivery.
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers,
    body: body as unknown as BodyInit,
  });

  if (response.status === 201 || response.status === 200) {
    return { kind: 'delivered' };
  }

  if (response.status === 404 || response.status === 410) {
    return { kind: 'dead' };
  }

  if (response.status === 429) {
    return { kind: 'retry' };
  }

  if (response.status === 401 || response.status === 403) {
    // The VAPID key is not accepted, and no number of retries changes that.
    return { kind: 'terminal', reason: `push service rejected the VAPID key (${response.status})` };
  }

  return { kind: 'terminal', reason: `push service returned ${response.status}` };
}

/**
 * Deliver a `PushNotificationRequested` event.
 *
 * Throws when the message should be retried, so the queue's own at-least-once
 * policy handles it. Everything else is recorded and swallowed: one browser
 * refusing a message must not block the others.
 */
export async function deliverPushNotification(
  payload: PushNotificationPayload,
  businessId: string,
  env: Bindings,
  fetcher: typeof fetch = fetch,
): Promise<PushDeliveryOutcome> {
  const db = createDb(env.DATABASE_URL);
  const empty: PushDeliveryOutcome = { delivered: 0, failed: 0, removed: 0, subscriptions: 0 };

  // Every write and read runs in a tenant transaction, and the push service is
  // called outside any of them: a transaction is not held open across the
  // network, and the queued row is committed before the send.
  const recipient = await withTenantTransaction(db, { businessId }, async (tx) => {
    // The customer, by the global id the event carries.
    //
    // The soft-deleted are excluded here. Deleting a customer in this platform
    // is an `UPDATE` of `deleted_at` and not a `DELETE`, so the row is still
    // there to be found — and the `ON DELETE CASCADE` on
    // `push_subscriptions.customer_id` never fires. A customer who asked to be
    // forgotten must not be pushed at, and the row that says they were forgotten
    // is the only thing that knows.
    const [customer] = await tx
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
      console.warn(`[communication] Customer ${payload.customer_id} not found — acking`);
      return null;
    }

    // The consent, checked again at the moment of the delivery.
    const consents = await readConsentMap(tx, { businessId, customerId: customer.id });
    if (consents[PUSH_CONSENT_TYPE] !== true) {
      console.log(
        `[communication] Customer ${payload.customer_id} has no nearby-notification consent — not delivering`,
      );
      return null;
    }

    const subscriptions = await readPushSubscriptions(tx, {
      businessId,
      customerId: customer.id,
    });

    return { customer, subscriptions };
  });

  if (!recipient) {
    return empty;
  }

  const { customer, subscriptions } = recipient;

  if (subscriptions.length === 0) {
    console.log(`[communication] Customer ${payload.customer_id} has no browser registered`);
    return empty;
  }

  // The audience of the push service is the endpoint itself.
  const plainPayload = new TextEncoder().encode(
    JSON.stringify({ title: payload.title, body: payload.body, url: payload.url ?? '/' }),
  );

  let delivered = 0;
  let failed = 0;
  let removed = 0;

  for (const subscription of subscriptions) {
    const endpointHash = await hashPushEndpoint(subscription.endpoint);

    // The reference names one delivery, not one message.
    //
    // The producer's reference says *what* was sent — a campaign, a promotion —
    // and the same string is handed to every browser a customer registered. On
    // its own it cannot tell two deliveries apart. The subscription's id is the
    // other half, and the two together are what identifies the delivery: a
    // campaign's rows all begin with the campaign's reference, and a campaign
    // that names one subscriber does not block the others.
    const referenceId = payload.reference_id
      ? `${payload.reference_id}:${subscription.id}`
      : subscription.id;

    // A delivery already decided is not made again. A queue retry redelivers
    // the whole event — a campaign whose tenth subscriber answered `429` comes
    // back for all ten — and an operator can compose the same campaign twice
    // before the first one's rows exist. Either way, a browser that already
    // received this reference, or refused it for good, is skipped. A row still
    // `queued` is an attempt that never finished, and is attempted again.
    //
    // The probe and the queued row commit together, and before the send: a
    // send whose row was never recorded would be a delivery nobody can see.
    const logEntry = await withTenantTransaction(db, { businessId }, async (tx) => {
      if (payload.reference_id) {
        const [decided] = await tx
          .select({ id: messageLog.id })
          .from(messageLog)
          .where(
            and(
              eq(messageLog.businessId, businessId),
              eq(messageLog.channel, 'push'),
              sql`${messageLog.content}->>'reference_id' = ${referenceId}`,
              inArray(messageLog.status, ['sent', 'failed']),
            ),
          )
          .limit(1);

        if (decided) return null;
      }

      // One row per delivery. The message is delivered once per browser, and
      // each of those has its own outcome, so each of those is its own row.
      const [entry] = await tx
        .insert(messageLog)
        .values({
          businessId,
          customerId: customer.id,
          direction: 'outbound',
          channel: 'push',
          status: 'queued',
          pushEndpointHash: endpointHash,
          content: {
            title: payload.title,
            body: payload.body,
            url: payload.url ?? '/',
            reference_id: referenceId,
            ...(payload.target !== undefined ? { target: payload.target } : {}),
            ...(payload.target_type !== undefined ? { target_type: payload.target_type } : {}),
            ...(payload.audience_size !== undefined ? { audience_size: payload.audience_size } : {}),
          },
        })
        .returning();

      return entry;
    });

    if (!logEntry) continue;

    let attempt: Attempt;
    try {
      const encrypted = await encryptPushPayload(plainPayload, {
        p256dh: subscription.p256dh,
        auth: subscription.auth,
      });

      const authorization = await buildVapidAuthorization(
        {
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY,
          subject: env.VAPID_SUBJECT,
        },
        new URL(subscription.endpoint).origin,
      );

      attempt = await attemptDelivery(
        subscription.endpoint,
        encrypted.body,
        {
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(encrypted.body.length),
          Encryption: `salt=${base64Url(encrypted.salt)}`,
          'Crypto-Key': `dh=${base64Url(encrypted.applicationServerKey)};p256ecdsa=${base64Url(encrypted.applicationServerKey)}`,
          Authorization: authorization,
          TTL: '86400',
          Urgency: 'normal',
        },
        fetcher,
      );
    } catch (err) {
      // The encryption or the network failed. The queue retries it.
      console.error(
        `[communication] Push delivery to ${endpointHash} could not be attempted:`,
        err,
      );
      throw err;
    }

    // The registration was answered, so it is alive.
    //
    // The freshness of a subscription is what keeps it: a registration nobody
    // has heard from for months is a browser that was uninstalled, or a site
    // whose data was cleared, and the sweep prunes it. A delivery attempt is
    // the proof that it is still there — and it is proof even when the delivery
    // failed, because a push service that answers "no" has still reached the
    // browser. So the moment the outcome is decided is the moment the
    // registration is refreshed.
    await withTenantTransaction(db, { businessId }, async (tx) => {
      await tx
        .update(pushSubscriptions)
        .set({ lastSeenAt: new Date() })
        .where(eq(pushSubscriptions.id, subscription.id));

      if (attempt.kind === 'delivered') {
        await tx.update(messageLog).set({ status: 'sent' }).where(eq(messageLog.id, logEntry.id));
        return;
      }

      if (attempt.kind === 'dead') {
        // The push service no longer holds the registration. The subscription
        // is removed: every future message would otherwise pay for a delivery
        // that cannot happen.
        await deletePushSubscriptionByEndpoint(tx, subscription.endpoint);
        await tx
          .update(messageLog)
          .set({
            status: 'failed',
            metadata: { error: 'The browser is no longer registered for push.' },
          })
          .where(eq(messageLog.id, logEntry.id));
        return;
      }

      if (attempt.kind === 'terminal') {
        await tx
          .update(messageLog)
          .set({ status: 'failed', metadata: { error: attempt.reason } })
          .where(eq(messageLog.id, logEntry.id));
      }

      // A `retry` leaves the row queued: only the registration is refreshed.
    });

    if (attempt.kind === 'delivered') {
      delivered += 1;
      continue;
    }

    if (attempt.kind === 'dead') {
      removed += 1;
      continue;
    }

    if (attempt.kind === 'retry') {
      // The message stays queued and the queue retries it.
      console.warn(
        `[communication] Push service asked us to slow down for ${endpointHash} — leaving queued`,
      );
      throw new Error('push service rate limited the delivery');
    }

    failed += 1;
  }

  return { delivered, failed, removed, subscriptions: subscriptions.length };
}

/** Base64url without padding, for the headers the push service expects. */
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
