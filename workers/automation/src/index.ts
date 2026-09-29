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
 * Runs daily at 6:00 AM (configured in wrangler.jsonc crons). Executes birthday
 * and inactivity cron checks, then hands off to the wallet's reconciliation
 * sweep.
 *
 * ## Why the sweep runs from here
 *
 * The account allows five cron triggers and is already using all five, so the
 * wallet cannot hold its own. Both workers wanted the same minute anyway, so one
 * trigger drives both.
 *
 * A cron invocation that throws is retried in full by the platform. Letting a
 * wallet failure escape would therefore re-run the birthday and inactivity jobs
 * from the start, which can re-send customer notifications. Those two have
 * already done their work by that point, so the failure is caught and logged:
 * the cost of a missed sweep day is one day, and the cost of a retried daily
 * notification is a customer receiving it twice.
 */
async function scheduled(_controller: unknown, env: Bindings): Promise<void> {
  await handleBirthdayCron(env);
  await handleInactivityCron(env);
  await dispatchWalletSweep(env);
}

/**
 * Calls the wallet's `scheduled` export over the service binding.
 *
 * Never throws. The wallet's own handler captures per-tenant failures into its
 * report, so reaching the catch below means something structural — a broken
 * binding, a failed deploy — and not a sweep that had a bad day.
 */
async function dispatchWalletSweep(env: Bindings): Promise<void> {
  try {
    await env.WALLET.scheduled(undefined);
  } catch (error) {
    console.error(
      '[automation] Wallet reconciliation sweep did not run:',
      error instanceof Error ? error.message : error,
    );
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export { queue, scheduled };
export default { fetch: app.fetch.bind(app), queue, scheduled };
