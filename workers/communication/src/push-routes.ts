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
import { and, eq, sql } from 'drizzle-orm';
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
 * The longest endpoint a subscription may carry.
 *
 * The endpoint is a `text` column and `text` is unbounded, so a caller could
 * hand this route a ten megabyte "endpoint" and make the platform store it.
 * A real push endpoint is a service URL with a token in it; two thousand
 * characters is already generous for one.
 */
export const MAX_ENDPOINT_LENGTH = 2048;

/**
 * The number of subscriptions a customer may hold before a new one is refused.
 *
 * The subscribe route is attacker-controlled input — the endpoint, the keys and
 * the count all come from the caller — and unbounded registration is a
 * storage-abuse vector: one caller could fill the table with registrations
 * that were never going to receive anything.
 *
 * A customer may hold several browsers: a phone and a laptop, or one browser
 * with two accounts, or the same browser in a normal and a private window. A
 * customer holds at most this many in all: the next new browser is refused,
 * because it is more likely to be abuse than a browser. A browser the customer
 * already holds is refreshed whatever the count — it is not a new one.
 */
export const MAX_SUBSCRIPTIONS_PER_CUSTOMER = 10;

/**
 * Is this an `https` URL?
 *
 * A push service is reached over TLS, and a scheme that is not `https` is not
 * a push service. The endpoint is also a capability, so it is refused before
 * it is stored rather than after.
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

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

  // -----------------------------------------------------------------------
  // The endpoint is attacker-controlled input
  // -----------------------------------------------------------------------
  // Both checks are here, before the database, because both are about the
  // shape of the request rather than about the customer: a refusal that
  // needed a round trip would still have to refuse, and a refusal that
  // reached the database could have written something on the way.
  if (endpoint.length > MAX_ENDPOINT_LENGTH) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: `subscription.endpoint must be at most ${MAX_ENDPOINT_LENGTH} characters.`,
        },
      },
      400,
    );
  }

  if (!isHttpsUrl(endpoint)) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'subscription.endpoint must be an https URL.',
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

  // -----------------------------------------------------------------------
  // How many browsers this customer already holds
  // -----------------------------------------------------------------------
  // A customer may hold a few: a phone and a laptop, or one browser with two
  // accounts. Past the cap it is not a browser any more, it is a caller
  // filling a table.
  //
  // The count and the write happen under one transaction-scoped lock per
  // customer. Without it, two requests could both count nine and both write,
  // and the cap would hold only for callers who wait for each other.
  const record = await db.transaction(async (tx) => {
    await withRls(tx, auth.businessId);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`push-subscriptions:${customerId}`}, 0))`,
    );

    const existing = await readPushSubscriptions(tx, {
      businessId: auth.businessId,
      customerId,
    });

    const others = existing.filter((subscription) => subscription.endpoint !== endpoint);
    if (others.length >= MAX_SUBSCRIPTIONS_PER_CUSTOMER) {
      return null;
    }

    return upsertPushSubscription(tx, {
      businessId: auth.businessId,
      customerId,
      endpoint,
      p256dh,
      auth: authSecret,
      userAgent: c.req.header('User-Agent') ?? null,
    });
  });

  if (!record) {
    return c.json(
      {
        error: {
          code: 'TOO_MANY_SUBSCRIPTIONS',
          message: `This customer already holds ${MAX_SUBSCRIPTIONS_PER_CUSTOMER} push subscriptions.`,
        },
      },
      429,
    );
  }

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
