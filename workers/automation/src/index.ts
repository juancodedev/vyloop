import type { MessageBatch } from '@cloudflare/workers-types';
import { consume } from '@vyloop/event-bus';
import type { EventEnvelope } from '@vyloop/event-bus';
import { getRequestId, logPrefix, requestIdMiddleware } from '@vyloop/request-context';
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

app.use('*', requestIdMiddleware());

/**
 * The set of paths that arrive without a gateway-injected identity.
 *
 * One entry, and it is a liveness probe: the worker is queue-driven, so the
 * probe comes from the platform and cannot carry `X-User-Id`.
 *
 * The exemption is an exact path, not a prefix. `/health/anything` stays behind
 * the middleware, which is the property a later route added under `/health`
 * would otherwise inherit silently.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/health']);

// ---------------------------------------------------------------------------
// Global middleware: auth header extraction
// ---------------------------------------------------------------------------

app.use('*', async (c, next) => {
  // Before the extraction, and on the raw path, so the exemption is exactly
  // the listed route rather than a prefix that could grow.
  if (PUBLIC_PATHS.has(new URL(c.req.url).pathname)) {
    await next();
    return;
  }

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
  const requestId = getRequestId(c);
  console.error(`${logPrefix('automation', requestId)} ${c.req.method} ${new URL(c.req.url).pathname}:`, err);

  if (err instanceof HTTPException) {
    return c.json(
      { error: { code: 'ERROR', message: err.message, request_id: requestId } },
      err.status,
    );
  }

  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', request_id: requestId } },
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
  await dispatchPassInactivity(env);
  await dispatchSubscriptionMaintenance(env);
}

/**
 * Calls the communication worker's `scheduled` export over the service
 * binding: the push subscription sweep, which has no cron trigger of its own.
 *
 * Never throws, for the reason `dispatchWalletSweep` does not.
 */
async function dispatchSubscriptionMaintenance(env: Bindings): Promise<void> {
  try {
    await env.COMMUNICATION.scheduled(undefined);
  } catch (error) {
    console.error(
      '[automation] Push subscription maintenance did not run:',
      error instanceof Error ? error.message : error,
    );
  }
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

/**
 * Calls the wallet's pass-inactivity rule over the same service binding.
 *
 * ## Why `dryRun: false` is written here, and only here
 *
 * This is the single production call site of a rule whose first execution moves
 * real customers' cards into Google's "Expired passes" section. So the writing is
 * stated at the one place that is allowed to state it, and the wallet's own
 * default is `dryRun: true` — a binding that passed nothing, or a future caller
 * that forgot, gets a report instead.
 *
 * ## Why it is a separate call, after the sweep
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * The sweep reads `customer_wallet_passes.last_synced_at` to decide what is due,
 * and `findInactivePassCandidates` reads `state` and the ledger. Running the
 * inactivity rule first would leave a pass this run deactivated before the sweep
 * ever looked at it, so the sweep would not get to reconcile it — and a pass
 * Google holds as `INACTIVE` with a balance that has since moved is a pass whose
 * number is wrong in a way only a re-add fixes.
 *
 * More importantly: the sweep refuses to run in demo mode, and the inactivity
 * rule is deliberately able to decide in demo mode. Calling it through
 * `env.WALLET.scheduled` would put it behind that refusal and it would never run.
 * A separate method is what keeps its fate independent.
 *
 * ## Never throws, for the same reason the sweep dispatch does not
 *
 * A cron invocation that throws is retried in full by the platform, which would
 * re-run the birthday and inactivity marketing jobs above and can re-send
 * customer notifications. Those have already done their work by this point.
 */
async function dispatchPassInactivity(env: Bindings): Promise<void> {
  try {
    await env.WALLET.deactivateInactivePasses({ dryRun: false });
  } catch (error) {
    console.error(
      '[automation] Wallet pass-inactivity deactivation did not run:',
      error instanceof Error ? error.message : error,
    );
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export { queue, scheduled };
export default { fetch: app.fetch.bind(app), queue, scheduled };
