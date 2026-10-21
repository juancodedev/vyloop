import type { KVNamespace } from '@cloudflare/workers-types';
import { publish, createEnvelope } from '@vyloop/event-bus';
import { getRequestId } from '@vyloop/request-context';
import { validate } from '@vyloop/schema-registry';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestorEnv {
  /**
   * The event schema registry.
   *
   * Declared in `wrangler.jsonc` since the binding was found missing in
   * production. The namespace is populated by the `register-schemas` deploy job,
   * not by this Worker: an empty registry is a valid state for KV to be in and an
   * invalid state for this route to answer from, so nothing at startup may be
   * relied on to have filled it.
   */
  SCHEMA_REGISTRY: KVNamespace;
  EVENT_QUEUE: Queue;
  // For hosted event types that need specific queues
  DOMAIN_EVENTS_QUEUE: Queue;
}

/**
 * The authenticated identity the gateway's auth middleware puts on the context.
 *
 * Only `business_id` is read here: this route never authorizes a role, it decides
 * which tenant an event belongs to, and that decision has exactly one trustworthy
 * source.
 */
type IngestorVariables = { jwt: { business_id: string } };

type Localization = {
  country?: string;
  currency?: string;
  timezone?: string;
  language?: string;
};

interface IngestorBody {
  header?: {
    business_id?: string;
    timestamp?: string;
    localization?: Localization;
  };
  payload?: unknown;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Mounted at `/v1/events` by `index.ts`, and only *there*.
 *
 * ## The mount point is the authentication
 *
 * This app used to be mounted at `/` with its own full paths, above every
 * `app.use('/v1/*', …)` in `index.ts`. Hono runs handlers in registration order,
 * so a route registered first answers first and the auth, auth-inject,
 * business-id and rate-limit middleware never ran for it: the ingestor was a
 * public write reachable by anyone who knew the hostname. Nothing crashed and no
 * test failed, because the route's own tests called it without a token — they
 * were asserting the bug.
 *
 * It is now registered below that whole chain, next to `POST /v1/support`, so a
 * request here arrives with a verified `jwt` and a `X-Business-ID` that matched
 * it. The tenant is read from that claim and **never** from the body; see the
 * handler.
 *
 * ## The registry this reads, and what an empty one looks like
 *
 * `SCHEMA_REGISTRY` is declared in `wrangler.jsonc` and points at the same
 * namespace `workers/{customer,growth,communication,automation}` bind — the
 * namespace id is a fact five configs have to agree on, held by
 * `schema-registry-namespace.contract.test.ts` and pinned by value in
 * `wrangler-config.contract.test.ts`.
 *
 * It used to be undeclared, and that produced a 500 on *every* event type,
 * registered or not, because the failure was a `kv.get()` on `undefined` before
 * any lookup happened. A declared-but-empty registry produces the 404 below
 * instead, which is a better failure and still a broken route — so the deploy
 * job populates the namespace before this Worker is published. See
 * `.github/workflows/deploy.yml` and `packages/schema-registry/scripts/`.
 *
 * ## Which event types exist
 *
 * Whatever `register-schemas` publishes. The registry is the contract; a name
 * absent from it answers 404. Keys are the event type in PascalCase plus a
 * version suffix, so `{type}` is `PointsAssigned`, not `points_assigned`: the
 * eight the deploy publishes are `CustomerCheckedIn`, `CustomerRegistered`,
 * `PointsAssigned`, `PushCampaignRequested`, `PushNotificationRequested`,
 * `RewardRedeemed`, `WhatsAppOutboundRequested` and `WorkflowTriggered`.
 *
 * The names this route was documented with for months — `purchase` and `custom`
 * — were never registered, so every caller following `docs/08-API-Design.md` got
 * a 404 from a route that had no traffic to explain it. Spell them the way the
 * registry does or the 404 comes back.
 */
const ingestor = new Hono<{ Bindings: IngestorEnv; Variables: IngestorVariables }>();

/**
 * POST /v1/events/{type} — authenticated.
 *
 * Validates the body against the Schema Registry, then publishes an envelope to
 * the event queue.
 *
 * Responses:
 * - 202 Accepted — event validated and published
 * - 400 SCHEMA_INVALID — body is not JSON, or does not match the schema
 * - 401 AUTH_TOKEN_INVALID — no verified identity on the context
 * - 403 EVENT_BUSINESS_MISMATCH — body names a tenant other than the token's
 * - 404 EVENT_TYPE_UNKNOWN — no schema registered for this event type
 *
 * ## The body may be an envelope or a bare payload
 *
 * Most registered types validate `{ header, payload }`; `CustomerRegistered`
 * validates the payload alone. Both are registered schemas, so both are
 * accepted: when the body carries a `payload` key it is
 * used as the envelope's payload, and otherwise the validated body *is* the
 * payload. Before this, the bare-payload shape published `payload: undefined`
 * under `business_id: "unknown"` — schema-valid and meaningless.
 *
 * ## Why a mismatched `header.business_id` is refused instead of overwritten
 *
 * The tenant written into the envelope is the one in the token, which is the only
 * value an attacker cannot choose. Silently replacing a body that names another
 * tenant would publish the right event under the wrong client's assumption and
 * leave the caller believing it wrote where it asked to; a 403 says which of the
 * two it was. `event-handler` in `workers/growth` then scopes everything it does
 * to `event.header.business_id`, so the claim has to be the token's before it
 * reaches the queue.
 */
ingestor.post('/:type', async (c) => {
  const eventType = c.req.param('type');
  const kv = c.env.SCHEMA_REGISTRY;

  // The middleware guarantees this. Asserted anyway, because the app is also
  // mounted directly by unit tests and because "the tenant is unknown" must never
  // fall back to a default: an envelope with `business_id: undefined` reaches a
  // consumer that scopes by that column.
  const jwt = c.get('jwt');
  if (!jwt?.business_id) {
    return c.json(
      {
        error: {
          code: 'AUTH_TOKEN_INVALID',
          message: 'JWT claims not found — this route requires authentication',
          request_id: getRequestId(c),
        },
      },
      401,
    );
  }

  // Validate content type
  const contentType = c.req.header('Content-Type');
  if (!contentType?.includes('application/json')) {
    return c.json(
      {
        error: {
          code: 'SCHEMA_INVALID',
          message: 'Content-Type must be application/json',
          request_id: getRequestId(c),
        },
      },
      400,
    );
  }

  let body: IngestorBody;
  try {
    body = await c.req.json<IngestorBody>();
  } catch {
    return c.json(
      {
        error: {
          code: 'SCHEMA_INVALID',
          message: 'Invalid JSON body',
          request_id: getRequestId(c),
        },
      },
      400,
    );
  }

  // `c.req.json()` types the result but does not constrain it: `null`, `[]` and
  // `"text"` all parse. The registry schemas are `type: 'object'`, so validation
  // rejects them below — except for the access to `body.header` before that,
  // which would throw on `null` and turn a bad request into a 500.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json(
      {
        error: {
          code: 'SCHEMA_INVALID',
          message: 'Event body must be a JSON object',
          request_id: getRequestId(c),
        },
      },
      400,
    );
  }

  // Validate against the schema registry
  const result = await validate(kv, eventType, body);

  if (!result.valid) {
    // Determine if it's a "schema not found" case (404) or "invalid payload" (400)
    const isUnknown = result.errors?.some((e) => e.includes('Schema not found'));
    if (isUnknown) {
      return c.json(
        {
          error: {
            code: 'EVENT_TYPE_UNKNOWN',
            message: `No schema registered for event type: "${eventType}"`,
            request_id: getRequestId(c),
          },
        },
        404,
      );
    }

    return c.json(
      {
        error: {
          code: 'SCHEMA_INVALID',
          message: 'Event payload does not match schema',
          details: result.errors,
          request_id: getRequestId(c),
        },
      },
      400,
    );
  }

  const declaredBusinessId = body.header?.business_id;
  if (declaredBusinessId !== undefined && declaredBusinessId !== jwt.business_id) {
    return c.json(
      {
        error: {
          code: 'EVENT_BUSINESS_MISMATCH',
          message: 'header.business_id does not match the authenticated business',
          request_id: getRequestId(c),
        },
      },
      403,
    );
  }

  // Extract header info for the envelope. `business_id` is the token's, always.
  const header: {
    business_id: string;
    timestamp: string;
    request_id?: string;
    localization?: Localization;
  } = {
    business_id: jwt.business_id,
    timestamp: body.header?.timestamp ?? new Date().toISOString(),
    request_id: getRequestId(c),
  };
  if (body.header?.localization) {
    header.localization = body.header.localization;
  }

  // A body with no `payload` key is the payload itself; see the route docblock.
  const payload = Object.hasOwn(body, 'payload') ? body.payload : body;

  const envelope = createEnvelope(eventType, header, payload);

  // Publish to the appropriate queue
  // - test_event goes to EVENT_QUEUE (dev)
  // - Domain events go to DOMAIN_EVENTS_QUEUE
  const queue = eventType === 'test_event' ? c.env.EVENT_QUEUE : c.env.DOMAIN_EVENTS_QUEUE;
  await publish(queue, envelope);

  return c.json(
    {
      accepted: true,
      event_id: envelope.id,
      event_type: eventType,
    },
    202,
  );
});

/**
 * GET /v1/events/health
 *
 * Authenticated like the write above, because it is mounted with it. It is kept
 * for a caller that already has a token and wants to know this route is wired;
 * the unauthenticated liveness probe for the gateway is `GET /health`.
 */
ingestor.get('/health', async (c) => {
  return c.json({ status: 'ok', service: 'event-ingestor' });
});

export { ingestor };
