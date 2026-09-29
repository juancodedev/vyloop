import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { createGoogleWalletRestClient } from './google-client';
import type { GoogleWalletClient } from './google-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Worker bindings.
 *
 * `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL`,
 * `GOOGLE_WALLET_PRIVATE_KEY` and `MEMBER_CODE_PEPPER` arrive through
 * `wrangler secret put` and are absent from `wrangler.jsonc`, `.dev.vars` and
 * the repository. `DATABASE_URL` and `WALLET_ALLOWED_ORIGINS` are plain vars.
 *
 * The issuer id and the service-account email are not secrets, but they are
 * real values from the Google Pay & Wallet console and a real Google Cloud
 * project, so they are configured per environment rather than defaulted here.
 */
export interface WalletBindings {
  /** Neon connection string, exactly as the other workers receive it. */
  DATABASE_URL: string;
  /**
   * The Google-issued issuer id. Not a secret, but not invented either: it is
   * a real value from the Google Pay & Wallet console, so it is configured per
   * environment rather than defaulted in code.
   *
   * The issuance routes deliberately do **not** read this. `tenant_wallet_programs
   * .issuer_id` is the authority, because the schema stores the issuer id per
   * row "so that moving to a different issuer is a data change and not a code
   * change" — a binding that silently outranked the row would make an issuer
   * migration require a redeploy and would let the two disagree. This binding
   * is the environment-level record of which issuer the deployment belongs to,
   * and the sync route's tests assert the two agree for the demo tenant.
   */
  GOOGLE_WALLET_ISSUER_ID: string;
  /** `client_email` from the service account JSON key. */
  GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: string;
  /**
   * `private_key` from the service account JSON key, PEM-encoded. Signs the
   * save-to-wallet JWT with RS256. Never in the repository, never in a test
   * fixture; tests generate their own key pair with WebCrypto and discard it.
   */
  GOOGLE_WALLET_PRIVATE_KEY: string;
  /**
   * Server-side secret for member-code derivation. Load-bearing: without it a
   * member code is recomputable by anyone who has scanned one pass. See
   * `member-code.ts`.
   */
  MEMBER_CODE_PEPPER: string;
  /**
   * Comma-separated list of origins the Add to Wallet control will be rendered
   * on. Becomes the `origins` claim of the save token, which Google requires:
   * the button does not render when the claim is absent. See
   * `parseAllowedOrigins` and `jwt.ts`.
   */
  WALLET_ALLOWED_ORIGINS: string;
  /**
   * Whether this deployment still lacks Google's publishing access, as
   * `'true'` or `'false'`.
   *
   * ## Why this is a var and not something we read from Google
   *
   * Google does not expose "is this issuer in demo mode" on any endpoint. A
   * demo-mode issuer account simply does not accept a pass from anyone outside
   * its own Admin/Developer/test accounts, and the only trace of it on our side
   * is the `[TEST ONLY] ` prefix Google requires on the object's `accountName`.
   * So the honest source for "are we still in demo mode" is a declaration this
   * deployment makes, and the one thing that flips it is Google's publishing
   * approval. See `parseDemoMode`.
   */
  WALLET_DEMO_MODE?: string | undefined;
}

/**
 * The identity the gateway injects after validating the customer's JWT.
 *
 * `userId` is the JWT subject, which is `customers.globalId` — not the
 * `customers.id` primary key that `points_transactions.customer_id` holds.
 * `businessId` is `tenants.id`; the rest of the model calls that column
 * `business_id` and the wallet tables call it `tenant_id`, and they are the
 * same value.
 */
export interface AuthHeaders {
  userId: string;
  businessId: string;
  userRole: string;
}

// ---------------------------------------------------------------------------
// Auth header extraction
// ---------------------------------------------------------------------------

/**
 * Extract X-User-Id, X-Business-Id, X-User-Role from request headers.
 * Throws 403 if any header is missing.
 *
 * These headers are injected by the gateway auth-inject middleware after JWT
 * validation.
 *
 * This is a verbatim copy of the same function in `workers/customer` and
 * `workers/growth`, and that duplication is deliberate for now and wrong in
 * principle: `packages/db/src/rls.ts` already documents the identical problem
 * with `withRls` being copied into four workers until it was moved into
 * `@vyloop/db`. The fix belongs in a shared package as its own change, not
 * smuggled into the wallet unit — a consolidation that also has to preserve
 * the customer worker's deliberate public-registration bypass is a change that
 * deserves its own review. What matters here is that the shape is identical to
 * the other workers, so a misconfigured gateway produces the same answer from
 * all of them.
 */
export function extractAuthHeaders(c: Context): AuthHeaders {
  const userId = c.req.header('X-User-Id');
  const businessId = c.req.header('X-Business-Id');
  const userRole = c.req.header('X-User-Role');

  if (!userId || !businessId || !userRole) {
    throw new HTTPException(403, { message: 'Missing authentication headers' });
  }

  return { userId, businessId, userRole };
}

// ---------------------------------------------------------------------------
// Customer role
// ---------------------------------------------------------------------------

/**
 * The role the customer app's token carries. Scopes every wallet route to the
 * holder's own loyalty record.
 */
const CUSTOMER_ROLE = 'customer';

/**
 * Is this the customer app's own token?
 *
 * The single owner of that question within this worker, mirroring
 * `isCustomerRole` in the growth worker. A route deciding it any other way is
 * how the pass and status reads end up disagreeing about whose data they are
 * allowed to touch.
 */
export function isCustomerRole(auth: AuthHeaders): boolean {
  return auth.userRole === CUSTOMER_ROLE;
}

/** Stable, specific code. Callers can branch on this without parsing prose. */
export const OPERATOR_ROLE_REQUIRED = 'OPERATOR_ROLE_REQUIRED';

export type OperatorRoleGuard = { ok: true } | { ok: false; status: 403; code: string; message: string };

/**
 * Refuse the customer app's token on a route that reads or refreshes the
 * tenant's Google program record.
 *
 * `POST /v1/wallet/program/sync` asks Google what the tenant's class review
 * state actually is and writes the answer to `tenant_wallet_programs`. That is
 * an operator action: it is a Google API call on the merchant's account, it
 * mutates tenant state, and the customer app has no surface for making one.
 *
 * Deliberately the *same* answer whatever the request would otherwise have
 * done. The guard reads nothing, so it cannot tell a provisioned tenant from an
 * unprovisioned one — there is no existence oracle to probe the tenant with, and
 * nothing is written on the way out.
 *
 * The counterpart to `isCustomerRole`, not a second source of truth about the
 * role: it denies by asking that question rather than by re-reading
 * `X-User-Role` or holding a list of operator roles.
 */
export function requireOperatorRole(auth: AuthHeaders): OperatorRoleGuard {
  if (isCustomerRole(auth)) {
    return {
      ok: false,
      status: 403,
      code: OPERATOR_ROLE_REQUIRED,
      message:
        'This endpoint reads and refreshes the Google Wallet program record for the business. Your own pass is at GET /v1/wallet/pass.',
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Allowed origins
// ---------------------------------------------------------------------------

/**
 * Parse the `WALLET_ALLOWED_ORIGINS` var into the `origins` claim.
 *
 * Trims each entry, drops empty ones and de-duplicates while preserving order,
 * so a trailing comma or a stray space in the var cannot produce an origins
 * array that Google rejects.
 *
 * Returns an empty array for an absent or blank var. That is not a fallback:
 * `createSaveToWalletUrl` refuses an empty `origins`, and the pass route turns
 * that into a `WALLET_NOT_CONFIGURED` 500. A misconfigured deployment must
 * report a misconfiguration, not mint a token whose button silently fails in
 * the browser.
 */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  if (raw === undefined || raw === null) return [];

  const seen = new Set<string>();
  const origins: string[] = [];

  for (const part of raw.split(',')) {
    const origin = part.trim();
    if (origin === '') continue;
    if (seen.has(origin)) continue;
    seen.add(origin);
    origins.push(origin);
  }

  return origins;
}

/**
 * Build the Google Wallet client for a request's bindings.
 *
 * ## Why this exists rather than an inline `createGoogleWalletRestClient` call
 *
 * So a test can substitute it. The real client's `fetch` defaults to the global
 * one, which in a Workers test environment means an actual attempt to reach
 * `oauth2.googleapis.com`. A route that constructed the client inline could only
 * be tested by letting that request fail, which is how a test ends up depending
 * on the absence of a network and asserting a 502 that is really a DNS error.
 *
 * One function, taking the bindings, returning the interface, is the seam. Every
 * caller that would otherwise reach for the network through it goes through this.
 */
export function googleWalletClientFor(env: WalletBindings): GoogleWalletClient {
  return createGoogleWalletRestClient({
    serviceAccountEmail: env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
    privateKeyPem: env.GOOGLE_WALLET_PRIVATE_KEY,
  });
}

/**
 * Is this deployment still in Google Wallet's Demo Mode?
 *
 * ## The default is `true`, and that is the whole point
 *
 * Absent, blank or unrecognised means **demo mode**, not the opposite. The
 * failure this guards is asymmetric: a deployment that *is* in demo mode and
 * answers "not in demo mode" hands a real customer a pass that only works on
 * the issuer's own test accounts, which is a support incident. A deployment
 * that has publishing access and answers "demo mode" is unavailable for a while,
 * which is a delay. Preferring the delay, and preferring it on a *typo* rather
 * than only on an absent value, is what makes the default worth having.
 *
 * ## Why the whole surface answers `false` while it is true
 *
 * A pass that only reaches test accounts is not a pass. Reporting it as
 * available would put "it is in your wallet" in front of a customer whose phone
 * will reject it, so `GET /v1/wallet/status` reports `available: false` with
 * `reason: 'demo_mode'` and `GET /v1/wallet/pass` refuses with a 409 carrying
 * the same code. The two agreeing is the point: this endpoint exists so a
 * client never renders a control that fails.
 *
 * The cost is real and worth naming: until publishing access is granted, the
 * live save-link path cannot be exercised through these two endpoints. A
 * developer or the issuer's own tester sets `WALLET_DEMO_MODE = 'false'` for
 * their environment, which is exactly the operation the var exists for. What is
 * *not* available is pretending a real customer's pass works.
 */
export function parseDemoMode(raw: string | undefined | null): boolean {
  if (raw === undefined || raw === null) return true;

  const normalised = raw.trim().toLowerCase();
  if (normalised === 'false' || normalised === '0' || normalised === 'no') return false;

  return true;
}
