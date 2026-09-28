import { Hono } from 'hono';

/**
 * `@vyloop/wallet` — Google Wallet loyalty passes (T1–T8).
 *
 * This unit is the **pass model**: id derivation, the member code, the
 * `LoyaltyClass` and `LoyaltyObject` payloads, balance formatting, the
 * save-to-wallet signer and the client boundary. It is deliberately not an
 * HTTP surface. The gateway registers this worker as a service binding, but no
 * route is exposed and no customer-facing control ships yet.
 *
 * T9 — the "Add to Google Wallet" button — is out of scope on purpose. Every
 * issuer starts in Demo Mode, so passes only reach the issuer's own
 * test accounts until publishing access is granted, and a `LoyaltyObject` needs
 * an approved class to exist at all. A button that fails is worse than no
 * button.
 */

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/**
 * Worker bindings. Every secret here arrives through `wrangler secret put` and
 * is absent from `wrangler.jsonc`, `.dev.vars` and the repository.
 */
export interface WalletBindings {
  /**
   * The Google-issued issuer id. Not a secret, but not invented either: it is
   * a real value from the Google Pay & Wallet console, so it belongs in a
   * secret or var configured per environment rather than in a default.
   */
  GOOGLE_WALLET_ISSUER_ID: string;
  /** `client_email` from the service account JSON key. */
  GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: string;
  /**
   * `private_key` from the service account JSON key, PEM-encoded. Signs the
   * save-to-wallet JWT with RS256. Never in the repository, never in a test
   * fixture; tests generate their own key pair with `node:crypto` and discard
   * it.
   */
  GOOGLE_WALLET_PRIVATE_KEY: string;
  /**
   * Server-side secret for member-code derivation. Load-bearing: without it a
   * member code is recomputable by anyone who has scanned one pass. See
   * `member-code.ts`.
   */
  MEMBER_CODE_PEPPER: string;
}

// ---------------------------------------------------------------------------
// Hono app
//
// No routes in this unit. The 404 and error envelope match the other workers so
// the gateway sees one consistent shape across services.
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: WalletBindings }>();

app.notFound((c) => {
  return c.json(
    { error: { code: 'NOT_FOUND', message: 'Route not found' } },
    404,
  );
});

app.onError((err, c) => {
  console.error('[wallet] Unhandled error:', err);
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
export * from './google-client';
export * from './ids';
export * from './jwt';
export * from './member-code';
export * from './object';

export default { fetch: app.fetch.bind(app) };
