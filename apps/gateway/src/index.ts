import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { brandRoute } from './brand';
import { ingestor } from './ingestor';
import { merchantPageRoute } from './merchant-page';
import { createMerchantPageReader } from './merchant-store';
import { authMiddleware } from './middleware/auth';
import { authInjectMiddleware } from './middleware/auth-inject';
import { businessIdMiddleware } from './middleware/business-id';
import {
  rateLimitMiddleware, SIGNUP_LIMIT_PER_WINDOW,
  DEFAULT_LIMITS,
  DEFAULT_WINDOW,
} from './middleware/rate-limit';
import { ROBOTS_PATH, robotsRoute, WALLET_CALLBACK_PATH } from './robots';
import { routerMiddleware, type GatewayEnv } from './router';

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: GatewayEnv }>();

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

app.use('*', cors());

// ---------------------------------------------------------------------------
// Public routes (no auth required)
// ---------------------------------------------------------------------------

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

// Public and unauthenticated, like everything a crawler must reach. Served by
// the Worker rather than straight off the assets layer so the Content-Type is
// guaranteed and the contract is testable through `app.fetch` — see `robots.ts`.
app.get(ROBOTS_PATH, robotsRoute());

// Mount the event ingestor — public endpoint for external event sources
app.route('/', ingestor);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Webhook paths bypass auth (Meta callbacks don't have X-User-Id etc.) */
const WEBHOOK_PREFIX = '/v1/communication/webhook';

/**
 * The Google Wallet pass callback, exempted from auth for the same reason.
 *
 * Declared in `robots.ts` and imported above, because that file has to name the
 * same path in `public/robots.txt` to keep it crawlable. One string, so the auth
 * exemption and the crawler rule cannot drift apart.
 *
 * ## What the exemption does and does not remove
 *
 * It removes the JWT requirement and the `X-Business-Id` requirement. It does
 * **not** remove authentication: the forwarded request is authenticated by the
 * wallet worker, which verifies an `ECv2SigningOnly` signature over the body
 * before it opens a database. Google has no JWT for this system and no business
 * id to send, so a token here would be a credential nobody could present.
 *
 * ## Why it is an exact match, not a prefix
 *
 * A prefix would exempt every path beneath it, so a future
 * `/v1/wallet/google/callback/admin` would silently become public too. An exact
 * comparison cannot grow. The same string is exported by the wallet worker
 * (`WALLET_CALLBACK_PATH`) and asserted against this list in
 * `index.test.ts`, so a rename on one side fails CI rather than producing a 403
 * on every real delivery — which is the failure mode nobody would read as a
 * routing bug.
 *
 * ## The three middlewares, and why the list is repeated
 *
 * `auth`, `authInject` and `businessId` each carry their own skip predicate, and
 * the callback has to be in all three. A miss in any one produces a 401/403 with
 * a message about missing headers, which is exactly what a broken signature
 * *also* looks like from the outside — so the duplication is worth the risk of
 * drift, and is covered by a test that reads all three.
 */
/**
 * True for a path that arrives without a gateway-injected identity.
 *
 * One predicate, called by all three middlewares, so the set of public
 * `/v1/*` paths is stated exactly once. The previous shape repeated the same
 * three-clause condition inline in each middleware, which is three chances to
 * forget a clause.
 */
function isPublicApiPath(path: string, method: string): boolean {
  return (
    path.startsWith('/v1/auth/') ||
    path.startsWith(WEBHOOK_PREFIX) ||
    path === WALLET_CALLBACK_PATH ||
    (method === 'PUT' && path === '/v1/customers')
  );
}

/**
 * Callbacks allowed per window, per client address.
 *
 * Deliberately generous. The threat is amplification — making this endpoint spend
 * two ECDSA verifications per request — and the number only has to be low enough
 * to bound that. It must *not* be low enough to break a real burst: Google
 * retries with backoff, and a busy merchant's saves all arrive from Googlebot
 * behind one address, so a tight limit would drop legitimate deliveries and leave
 * a pass's state wrong with no error here to explain it.
 */
const WALLET_CALLBACK_LIMIT_PER_WINDOW = 600;

// ---------------------------------------------------------------------------
// Middleware chain for /v1/* routes
// ---------------------------------------------------------------------------

// Middleware 1: Auth (JWT validation) — skip auth routes + customer registration
app.use('/v1/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;

  // Public routes — no JWT required
  if (isPublicApiPath(path, method)) {
    await next();
    return;
  }

  const secret = (c.env as GatewayEnv).JWT_SECRET;
  if (!secret) {
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' } },
      500,
    );
  }

  // Run the auth middleware factory and return its result (Response or undefined to continue)
  return authMiddleware(secret)(c, next);
});

// Middleware 2: Auth header injection — strip incoming X-* headers, inject from JWT
// MUST run before business-id enforcement and router so injected headers
// are available for validation and forwarding.
app.use('/v1/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;

  // Skip for public routes — no JWT to inject from
  if (isPublicApiPath(path, method)) {
    await next();
    return;
  }

  return authInjectMiddleware()(c, next);
});

// Middleware 3: X-Business-ID enforcement — skip /v1/auth/* + registration + webhooks
app.use('/v1/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;
  if (isPublicApiPath(path, method)) {
    await next();
    return;
  }
  return businessIdMiddleware(c, next) as unknown as ReturnType<typeof next>;
});

  // Middleware 4: Rate limiting
  //
  // `/v1/auth/*` used to be skipped wholesale, which was right while every route
  // under it was a cheap credential check. It is no longer right: signup creates a
  // tenant and runs a 100k-iteration key derivation, and it is public. The skip
  // is replaced by a per-route anonymous limit, so the exemption is now a number
  // someone chose rather than a prefix nobody has to justify.
  app.use('/v1/*', async (c, next) => {
    const env = c.env as GatewayEnv;
    return rateLimitMiddleware({
      kv: env.RATE_LIMITER,
      limits: DEFAULT_LIMITS,
      // The login route is left unlimited on purpose and the signup route is
      // not: a login is a credential check whose cost is one PBKDF2, and locking
      // a legitimate user out of their own account because someone else guessed
      // at it is a worse failure than the traffic it lets through. A signup also
      // runs that derivation, and additionally creates a tenant, so it gets a
      // number a human waiting on a form will not notice and a script will.
      //
      // The Google Wallet callback is the same shape for a different reason: it
      // is unauthenticated, and an unauthenticated request still costs two ECDSA
      // verifications before it is refused. Without a limit this is a public
      // endpoint whose every request spends CPU on the attacker's behalf.
      //
      // It is set **high on purpose**. Google retries with backoff and the
      // number is per client address, not per tenant, so a busy merchant's
      // callbacks share a bucket with everything else behind that address; a
      // limit tight enough to throttle a forgery campaign would also throttle a
      // legitimate burst of saves. It is a ceiling on amplification, not a
      // security control — the signature is.
      anonymousLimits: {
        '/v1/auth/business/signup': SIGNUP_LIMIT_PER_WINDOW,
        '/v1/wallet/google/callback': WALLET_CALLBACK_LIMIT_PER_WINDOW,
      },
      windowSeconds: DEFAULT_WINDOW,

  })(c, next);
});

// Middleware 5: Route dispatch to service bindings
app.use('/v1/*', routerMiddleware);

// ---------------------------------------------------------------------------
// Brand assets
// ---------------------------------------------------------------------------

// Public, and unauthenticated on purpose: Google Wallet fetches a class's
// images server-side with no credentials, so anything that protects a logo also
// prevents the pass from rendering. What protects it is that the bucket is
// private and this is the only route to it.
app.get('/brand/*', brandRoute());

// ---------------------------------------------------------------------------
// The public per-merchant page
// ---------------------------------------------------------------------------

// Public, unauthenticated, and outside `/v1/*` — so the auth, auth-inject,
// business-id, rate-limit and routing middleware above never run for it. That is
// structural rather than an exemption anyone has to maintain: those five are all
// registered with `app.use('/v1/*', …)`, exactly as `/brand/*` is public because
// it is not under that prefix. Google opens this URL while reviewing a loyalty
// class with no credentials, and it has to answer with HTML in the response body.
//
// Registered as `/p/*`, and `merchantPageRoute` takes the pathname off
// `c.req.url` itself rather than a `:slug` param. `/p/:slug` would also match,
// but the router resolves a param against its own routing table, and the guard
// that has to refuse an encoded traversal wants the one string nothing else has
// touched.
//
// The reader is built per request from `c.env` rather than captured at module
// scope: `createDb` opens a pool and an isolate is reused across requests, so a
// pool held in module state is a different object here than in a test.
app.get(
  '/p/*',
  async (c) => merchantPageRoute(createMerchantPageReader(c.env))(c),
);

// 404 handler
// ---------------------------------------------------------------------------

app.notFound((c) => {
  return c.json(
    {
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
        request_id: crypto.randomUUID(),
      },
    },
    404,
  );
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  console.error('Gateway error:', err);
  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        request_id: crypto.randomUUID(),
      },
    },
    500,
  );
});

export default app;
