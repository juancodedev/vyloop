import type { MessageBatch } from '@cloudflare/workers-types';
import { consume } from '@vyloop/event-bus';
import type { EventEnvelope } from '@vyloop/event-bus';
import { createErrorHandler, requestIdMiddleware } from '@vyloop/request-context';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { handleEvent } from './event-handler';
import type { Bindings } from './helpers';
import { extractAuthHeaders } from './helpers';
import router, { PAYMENT_WEBHOOK_PATH, type GrowthEnv } from './routes';




// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: GrowthEnv; Variables: { auth: ReturnType<typeof extractAuthHeaders> } }>();

app.use('*', requestIdMiddleware());

// ---------------------------------------------------------------------------
// Global middleware: auth header extraction
// ---------------------------------------------------------------------------

/**
 * The paths that arrive without a gateway-injected identity.
 *
 * Mirrors `workers/wallet/src/index.ts`, which is the pattern this was copied
 * from, and the copy is deliberate: this middleware is the fifth instance of the
 * same defect in this repository — a route registered correctly, tested green,
 * and unreachable because a layer in front of it refuses.
 *
 * ## Why this route needs an entry at all
 *
 * A payment rail is a third party. It has no Vyloop account, no JWT and no
 * business id to send, so `extractAuthHeaders` below throws `403 UNAUTHORIZED`
 * for every delivery — and the route behind it, which verifies an HMAC signature
 * and resolves the merchant from the payload, would be complete, covered by tests
 * and answering nothing in every environment. The symptom would be a 403 whose
 * message is about missing headers, which is indistinguishable from a gateway
 * misconfiguration and sends the reader to the wrong file.
 *
 * ## Why exactly one path, and why not a prefix
 *
 * A prefix would exempt every path beneath it, so a future
 * `/v1/loyalty/webhooks/payments/admin` would silently become public too. This is
 * a `ReadonlySet` compared against the **raw** pathname, so the exemption is
 * exactly the listed route.
 *
 * One entry, because one route needs it. A public exemption is a hole cut in the
 * auth middleware, so a stale name here does not fail loudly: it 403s a route that
 * is gone, or leaves a live route authenticated.
 *
 * `apps/gateway/src/worker-public-path-auth.contract.test.ts` asserts that every
 * path the gateway treats as public is exempted here, and that the gateway's copy
 * of this string matches the one in `routes.ts`. Without that file this set and
 * the gateway's `EXACT_PUBLIC_PATHS` would be two lists in two packages that
 * nothing compared — and a rename on one side would 403 every real delivery.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([PAYMENT_WEBHOOK_PATH]);

app.use('*', async (c, next) => {
  // Checked before the extraction, and on the raw path, so the exemption is
  // exactly the listed routes rather than a prefix that could grow.
  if (PUBLIC_PATHS.has(new URL(c.req.url).pathname)) {
    await next();
    return;
  }

  try {
    // Extract and validate auth headers (injected by gateway).
    extractAuthHeaders(c);

    await next();
  } catch (err) {
    if (err instanceof HTTPException) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: err.message } },
        err.status,
      );
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.route('/', router);

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.notFound((c) => {
  return c.json(
    { error: { code: 'NOT_FOUND', message: 'Route not found' } },
    404,
  );
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.onError(createErrorHandler('growth'));

// ---------------------------------------------------------------------------
// Queue consumer
// ---------------------------------------------------------------------------

async function queue(batch: MessageBatch<EventEnvelope>, env: Bindings): Promise<void> {
  await consume(batch, (event, msg) => handleEvent(event, msg, env));
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export { queue };
export default { fetch: app.fetch.bind(app), queue };
