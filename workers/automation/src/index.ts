import type { MessageBatch } from '@cloudflare/workers-types';
import { consume } from '@vyloop/event-bus';
import type { EventEnvelope } from '@vyloop/event-bus';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { handleBirthdayCron, handleInactivityCron } from './cron-handler';
import { handleEvent } from './event-handler';
import type { Bindings } from './helpers';
import { extractAuthHeaders } from './helpers';
import router from './routes';

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Bindings; Variables: { auth: ReturnType<typeof extractAuthHeaders> } }>();

// ---------------------------------------------------------------------------
// Global middleware: auth header extraction
// ---------------------------------------------------------------------------

app.use('*', async (c, next) => {
  try {
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

app.onError((err, c) => {
  console.error('[automation] Unhandled error:', err);

  if (err instanceof HTTPException) {
    return c.json(
      { error: { code: 'ERROR', message: err.message } },
      err.status,
    );
  }

  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    500,
  );
});

// ---------------------------------------------------------------------------
// Queue consumer
// ---------------------------------------------------------------------------

async function queue(batch: MessageBatch<EventEnvelope>, env: Bindings): Promise<void> {
  await consume(batch, (event, msg) => handleEvent(event, msg, env));
}

// ---------------------------------------------------------------------------
// Cron handler
// ---------------------------------------------------------------------------

/**
 * Scheduled trigger handler.
 *
 * Runs daily at 6:00 AM (configured in wrangler.jsonc crons).
 * Executes birthday and inactivity cron checks.
 */
async function scheduled(_controller: unknown, env: Bindings): Promise<void> {
  await handleBirthdayCron(env);
  await handleInactivityCron(env);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export { queue, scheduled };
export default { fetch: app.fetch.bind(app), queue, scheduled };
