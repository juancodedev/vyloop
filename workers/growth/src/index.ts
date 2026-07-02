import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { MessageBatch } from '@cloudflare/workers-types';
import type { Bindings } from './helpers';
import { extractAuthHeaders } from './helpers';
import router from './routes';
import { consume } from '@vyloop/event-bus';
import { handleEvent } from './event-handler';
import type { EventEnvelope } from '@vyloop/event-bus';

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Bindings; Variables: { auth: ReturnType<typeof extractAuthHeaders> } }>();

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
  console.error('[growth] Unhandled error:', err);

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
// Export
// ---------------------------------------------------------------------------

export { queue };
export default { fetch: app.fetch.bind(app), queue };
