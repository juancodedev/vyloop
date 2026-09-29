import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { AuthHeaders, WalletBindings } from './helpers';
import { extractAuthHeaders } from './helpers';
import router from './routes';

/**
 * `@vyloop/wallet` — Google Wallet loyalty passes.
 *
 * ## Two halves
 *
 * The **pass model** (T1–T8) is pure: id derivation, the member code, the
 * `LoyaltyClass` and `LoyaltyObject` payloads, balance formatting, the
 * save-to-wallet signer and the Google REST client boundary. It has no database
 * and makes no network call, and none of that changed when the HTTP surface
 * landed.
 *
 * The **issuance surface** is this unit's HTTP half: three routes, a persistence
 * boundary, and the rules that decide whether a customer can obtain a pass.
 * Those rules live in `issuance.ts` as plain functions over a `WalletStore`, so
 * they can be broken one at a time without a database.
 *
 * ## T9 is still not here, and that is deliberate
 *
 * There is no "Add to Google Wallet" button anywhere in this repository, and
 * adding one is a separate change gated on publishing access. The API below is
 * what such a button would call, and `GET /v1/wallet/status` is the endpoint
 * that button would have to ask before rendering itself — so the control can
 * never appear over a pass that will fail. Stage 7's delivery gate in
 * `apps/customer-web` forbids the CTA until publishing access is granted, and
 * nothing in this worker relaxes it.
 *
 * Every account starts in Demo Mode, so even a working button would only reach
 * the issuer's own test accounts until Google's publishing approval lands.
 */

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

export type { AuthHeaders, WalletBindings } from './helpers';

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: WalletBindings; Variables: { auth: AuthHeaders } }>();

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
  console.error('[wallet] Unhandled error:', err);

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
// Public surface
// ---------------------------------------------------------------------------

export * from './balance';
export * from './class';
export * from './drizzle-store';
export * from './google-client';
export * from './helpers';
export * from './ids';
export * from './issuance';
export * from './jwt';
export * from './member-code';
export * from './object';
export * from './reconcile';
export * from './store';

export default { fetch: app.fetch.bind(app) };
