import {
  createDb,
  customers,
  deletePushSubscriptionByEndpoint,
  hashPushEndpoint,
  messageLog,
  readConsentMap,
  readPushSubscriptions,
} from '@vyloop/db';
import { and, eq } from 'drizzle-orm';

import type { Bindings } from './helpers';
import { withRls } from './helpers';
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
  await withRls(db, businessId);

  // The customer, by the global id the event carries.
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.globalId, payload.customer_id)))
    .limit(1);

  if (!customer) {
    console.warn(`[communication] Customer ${payload.customer_id} not found — acking`);
    return { delivered: 0, failed: 0, removed: 0, subscriptions: 0 };
  }

  // The consent, checked again at the moment of the delivery.
  const consents = await readConsentMap(db, { businessId, customerId: customer.id });
  if (consents[PUSH_CONSENT_TYPE] !== true) {
    console.log(
      `[communication] Customer ${payload.customer_id} has no nearby-notification consent — not delivering`,
    );
    return { delivered: 0, failed: 0, removed: 0, subscriptions: 0 };
  }

  const subscriptions = await readPushSubscriptions(db, {
    businessId,
    customerId: customer.id,
  });

  if (subscriptions.length === 0) {
    console.log(`[communication] Customer ${payload.customer_id} has no browser registered`);
    return { delivered: 0, failed: 0, removed: 0, subscriptions: 0 };
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

    // One row per delivery. The message is delivered once per browser, and
    // each of those has its own outcome, so each of those is its own row.
    const [logEntry] = await db
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
          reference_id: payload.reference_id ?? null,
        },
      })
      .returning();

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

    if (attempt.kind === 'delivered') {
      delivered += 1;
      await db.update(messageLog).set({ status: 'sent' }).where(eq(messageLog.id, logEntry.id));
      continue;
    }

    if (attempt.kind === 'dead') {
      // The push service no longer holds the registration. The subscription is
      // removed: every future message would otherwise pay for a delivery that
      // cannot happen.
      removed += 1;
      await deletePushSubscriptionByEndpoint(db, subscription.endpoint);
      await db
        .update(messageLog)
        .set({
          status: 'failed',
          metadata: { error: 'The browser is no longer registered for push.' },
        })
        .where(eq(messageLog.id, logEntry.id));
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
    await db
      .update(messageLog)
      .set({ status: 'failed', metadata: { error: attempt.reason } })
      .where(eq(messageLog.id, logEntry.id));
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
