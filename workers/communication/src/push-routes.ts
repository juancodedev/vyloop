import {
  createDb,
  customers,
  deletePushSubscription,
  hashPushEndpoint,
  readConsentMap,
  readPushSubscriptions,
  upsertPushSubscription,
} from '@vyloop/db';
import { isCustomerRole } from '@vyloop/types';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { Bindings } from './helpers';
import { extractAuthHeaders, withRls } from './helpers';

// ---------------------------------------------------------------------------
// Push subscriptions.
//
// A subscription is a browser's registration with a push service. The customer
// registers their own browser; the platform then has somewhere to deliver a
// message.
//
// ## The consent
//
// Registering a browser is asking to be contacted on it, so it needs the
// customer's consent — and the consent that matters is the one for **nearby
// notifications**, which is what a push message would carry. The consent lives
// in the `consents` table, which is the authoritative store.
//
// The customer is resolved by `(global_id, business_id)`: the token's subject
// is the global id, and the same person is a different customer at a
// different merchant, so the business is part of the identity and not a
// decoration on it.
//
// ## What the endpoints never say
//
// The endpoint is a capability. It is not echoed in a response, it is not in a
// log, and the list answers with a digest of it instead. `p256dh` and `auth`
// are the browser's key material and are never returned either.
// ---------------------------------------------------------------------------

const router = new Hono<{ Bindings: Bindings }>();

/** The consent a push subscription requires. */
const PUSH_CONSENT_TYPE = 'nearby_notifications';

/**
 * Resolve the customer behind the request.
 *
 * Returns the customer's internal id, which is what the subscription row
 * references. `null` when the token names no customer of this business.
 */
async function resolveCustomer(
  db: ReturnType<typeof createDb>,
  businessId: string,
  globalId: string,
): Promise<string | null> {
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.globalId, globalId)))
    .limit(1);

  return customer?.id ?? null;
}

/**
 * Refuse a caller that is not a customer.
 *
 * A subscription is a browser that messages will be delivered to. An operator
 * registering one on a customer's behalf is a business pushing at a browser its
 * customer did not offer, and nothing in the product needs it.
 */
function requireCustomer(auth: { userRole: string }): { ok: true } | { ok: false } {
  if (!isCustomerRole(auth.userRole)) {
    return { ok: false };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// POST /v1/communication/push/subscribe
// ---------------------------------------------------------------------------

router.post('/v1/communication/push/subscribe', async (c) => {
  const auth = extractAuthHeaders(c);
  if (!requireCustomer(auth).ok) {
    return c.json(
      {
        error: {
          code: 'CUSTOMER_TOKEN_REQUIRED',
          message: 'Only a customer can register a browser for push messages.',
        },
      },
      403,
    );
  }

  let body: {
    subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Body must be JSON' } }, 400);
  }

  const subscription = body.subscription;
  const endpoint = typeof subscription?.endpoint === 'string' ? subscription.endpoint.trim() : '';
  const p256dh = typeof subscription?.keys?.p256dh === 'string' ? subscription.keys.p256dh : '';
  const authSecret = typeof subscription?.keys?.auth === 'string' ? subscription.keys.auth : '';

  if (!endpoint || !p256dh || !authSecret) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'subscription.endpoint, subscription.keys.p256dh and subscription.keys.auth are required.',
        },
      },
      400,
    );
  }

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, auth.businessId);

  const customerId = await resolveCustomer(db, auth.businessId, auth.userId);
  if (!customerId) {
    return c.json({ error: { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' } }, 404);
  }

  // The consent gate. A browser that is registered without the customer having
  // agreed to be contacted on it is a business holding a channel to a customer
  // who never asked for one.
  const consents = await readConsentMap(db, {
    businessId: auth.businessId,
    customerId,
  });
  if (consents[PUSH_CONSENT_TYPE] !== true) {
    return c.json(
      {
        error: {
          code: 'CONSENT_REQUIRED',
          message: 'The customer has not consented to nearby notifications.',
        },
      },
      403,
    );
  }

  const record = await upsertPushSubscription(db, {
    businessId: auth.businessId,
    customerId,
    endpoint,
    p256dh,
    auth: authSecret,
    userAgent: c.req.header('User-Agent') ?? null,
  });

  // The id and the moment, and nothing else. The endpoint is a capability and
  // the keys are the browser's.
  return c.json(
    {
      subscription: {
        id: record.id,
        endpoint_hash: await hashPushEndpoint(record.endpoint),
        created_at: record.createdAt.toISOString(),
      },
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// POST /v1/communication/push/unsubscribe
// ---------------------------------------------------------------------------

router.post('/v1/communication/push/unsubscribe', async (c) => {
  const auth = extractAuthHeaders(c);
  if (!requireCustomer(auth).ok) {
    return c.json(
      {
        error: {
          code: 'CUSTOMER_TOKEN_REQUIRED',
          message: 'Only a customer can remove a browser from push messages.',
        },
      },
      403,
    );
  }

  let body: { endpoint?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Body must be JSON' } }, 400);
  }

  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  if (!endpoint) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'endpoint is required.' } },
      400,
    );
  }

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, auth.businessId);

  const removed = await deletePushSubscription(db, {
    businessId: auth.businessId,
    endpoint,
  });

  // 404 when there was nothing to remove: the caller asked to stop a
  // subscription that was not there, and the answer is the same either way.
  if (!removed) {
    return c.json(
      { error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'No such push subscription.' } },
      404,
    );
  }

  return c.json({ removed: true });
});

// ---------------------------------------------------------------------------
// GET /v1/communication/push/subscriptions
// ---------------------------------------------------------------------------

router.get('/v1/communication/push/subscriptions', async (c) => {
  const auth = extractAuthHeaders(c);
  if (!requireCustomer(auth).ok) {
    return c.json(
      {
        error: {
          code: 'CUSTOMER_TOKEN_REQUIRED',
          message: 'Only a customer can list the browsers registered for push messages.',
        },
      },
      403,
    );
  }

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, auth.businessId);

  const customerId = await resolveCustomer(db, auth.businessId, auth.userId);
  if (!customerId) {
    return c.json({ error: { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' } }, 404);
  }

  const records = await readPushSubscriptions(db, {
    businessId: auth.businessId,
    customerId,
  });

  const subscriptions = await Promise.all(
    records.map(async (record) => ({
      id: record.id,
      endpoint_hash: await hashPushEndpoint(record.endpoint),
      created_at: record.createdAt.toISOString(),
      last_seen_at: record.lastSeenAt ? record.lastSeenAt.toISOString() : null,
    })),
  );

  return c.json({ subscriptions, total: subscriptions.length });
});

export default router;
