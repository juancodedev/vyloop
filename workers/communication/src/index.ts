import type { MessageBatch } from '@cloudflare/workers-types';
import { consume } from '@vyloop/event-bus';
import type { EventEnvelope } from '@vyloop/event-bus';
import { createErrorHandler, requestIdMiddleware } from '@vyloop/request-context';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import campaignRouter from './campaign-routes';
import deliveryStatsRouter from './delivery-stats';
import { handleEvent } from './event-handler';
import type { Bindings } from './helpers';
import { extractAuthHeaders } from './helpers';
import pushRouter from './push-routes';
import router from './routes';
import { handleSubscriptionMaintenance } from './subscription-maintenance';

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Bindings; Variables: { auth: ReturnType<typeof extractAuthHeaders> } }>();

app.use('*', requestIdMiddleware());

// ---------------------------------------------------------------------------
// Global middleware: auth header extraction
// ---------------------------------------------------------------------------

app.use('*', async (c, next) => {
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
app.route('/', pushRouter);
app.route('/', campaignRouter);
app.route('/', deliveryStatsRouter);

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

app.onError(createErrorHandler('communication'));

// ---------------------------------------------------------------------------
// Queue consumer
// ---------------------------------------------------------------------------

async function queue(batch: MessageBatch<EventEnvelope>, env: Bindings): Promise<void> {
  await consume(batch, (event, msg) => handleEvent(event, msg, env));
}

// ---------------------------------------------------------------------------
// Scheduled
// ---------------------------------------------------------------------------

/**
 * The subscription maintenance sweep.
 *
 * This worker has no cron trigger of its own — the account's five are taken.
 * The automation worker calls this export over a service binding from its
 * daily cron, the way it dispatches the wallet sweep. The sweep never throws.
 */
async function scheduled(_controller: unknown, env: Bindings): Promise<void> {
  await handleSubscriptionMaintenance(env);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export { queue };
export { scheduled };
export default { fetch: app.fetch.bind(app), queue, scheduled };
