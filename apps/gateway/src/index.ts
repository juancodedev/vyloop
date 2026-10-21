import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';

import { brandRoute } from './brand';
import { ingestor } from './ingestor';
import { merchantPageRoute, parseCustomerWebBaseUrl } from './merchant-page';
import { createMerchantPageReader } from './merchant-store';
import { authMiddleware } from './middleware/auth';
import { authInjectMiddleware } from './middleware/auth-inject';
import { businessIdMiddleware } from './middleware/business-id';
import {
  rateLimitMiddleware, SIGNUP_LIMIT_PER_WINDOW, POS_TOKEN_LIMIT_PER_WINDOW,
  DEFAULT_LIMITS,
  DEFAULT_WINDOW,
} from './middleware/rate-limit';
import { ROBOTS_PATH, robotsRoute, WALLET_CALLBACK_PATH } from './robots';
import { routerMiddleware, type GatewayEnv } from './router';
import { SUPPORT_LIMIT_PER_WINDOW, SUPPORT_PATH, supportRoute } from './support';

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Webhook paths bypass auth (Meta callbacks don't have X-User-Id etc.) */
export const WEBHOOK_PREFIX = '/v1/communication/webhook';

/**
 * Where a payment rail delivers a settlement notification.
 *
 * Declared here rather than imported, because `apps/gateway` must not take a
 * runtime dependency on the service behind it — the same reason
 * `WALLET_CALLBACK_PATH` is declared twice, once here and once in
 * `workers/wallet/src/routes.ts`. That dependency direction is the right one for a
 * public face, so the agreement is asserted by reading the worker's source instead
 * of importing it.
 *
 * ## Why this is an exact path and not a member of `WEBHOOK_PREFIX`
 *
 * `WEBHOOK_PREFIX` exempts a whole subtree, and the warning at its own
 * registration is about paths with genuinely different costs behind one name.
 * Adding the payment receiver there would make every future
 * `/v1/communication/webhook/*` route public because a payment rail happens to
 * post to one — which is precisely the "a prefix can grow" argument the exact set
 * exists to make impossible. And it would hide the receiver inside a namespace
 * whose worker (`communication`) does not serve it: `/v1/loyalty` routes to
 * `growth`, so the exemption and the route would be claiming different packages.
 *
 * ## What the exemption removes, and what replaces it
 *
 * It removes the JWT requirement and the `X-Business-Id` requirement. It does not
 * remove authentication: the growth worker verifies an HMAC-SHA256 signature over
 * the raw body before it parses anything, and refuses a delivery that presents a
 * Vyloop credential with `PAYMENT_WEBHOOK_CREDENTIAL_NOT_ALLOWED`. A payment rail
 * has no JWT for this system and no business id to send, so a token here would be
 * a credential nobody could present.
 */
export const PAYMENT_WEBHOOK_PATH = '/v1/loyalty/webhooks/payments';

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
 * comparison cannot grow. `index.test.ts` holds that narrowness end to end, from
 * outside this module, by asserting the sibling answers 401.
 *
 * The string is declared twice — here via `./robots`, and in the worker — because
 * this package must not take a runtime dependency on the service behind it. That
 * dependency direction is the right one for a public face, so the agreement is
 * asserted by reading the worker's source instead of importing it:
 * `wallet-callback-path.contract.test.ts` compares the two and fails in either
 * direction. Before that file existed the narrowing was asserted and the agreement
 * was not, so a one-sided rename 403'd every real delivery with a message about
 * missing headers — the failure mode nobody would read as a routing bug.
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
 *
 * Exported so the list can be asserted directly rather than only inferred from a
 * request. A public-path predicate that cannot be inspected is a predicate nobody
 * can prove is still narrow. Two files hold that narrowness: `index.test.ts`
 * drives `app.fetch` and asserts that `/v1/wallet/google/callback/admin` and the
 * other `/v1/wallet/*` paths answer 401, and
 * `wallet-callback-path.contract.test.ts` asserts it off the predicate directly
 * and end to end. The middleware chain, not this function, is what decides — but
 * a predicate that cannot be inspected cannot be argued about either.
 *
 * The second exact entry is `SUPPORT_PATH`, and it is a different exemption from
 * the callback in every respect that matters. The callback is exempt because
 * Google has no JWT to send; this one is exempt because **the person who needs to
 * write to us is the person whose registration failed**, so a session is exactly
 * the credential they do not have. What replaces the JWT here is a Turnstile token
 * and a rate limit, both of which are named below, and the honeypot inside the
 * route — none of which identifies anybody, which is the point: this route reads
 * no account and writes none.
 */
export function isPublicApiPath(path: string, method: string): boolean {
  return (
    path.startsWith('/v1/auth/') ||
    path.startsWith(WEBHOOK_PREFIX) ||
    EXACT_PUBLIC_PATHS.includes(path) ||
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

/**
 * Settlement notifications per window, per client address.
 *
 * See the `ANONYMOUS_LIMITS` entry below for why this is 600 and not 3, and why
 * it is a ceiling on amplification rather than a security control. It is its own
 * named constant so that changing it is one line and not a search — the same
 * reason `WALLET_CALLBACK_LIMIT_PER_WINDOW` above is.
 */
const PAYMENT_WEBHOOK_LIMIT_PER_WINDOW = 600;

/**
 * The public `/v1/*` paths this gateway names **one by one**, as opposed to the
 * two it names by prefix.
 *
 * Exported because the set has a rule attached to it that nothing else can
 * enforce: an exact-match public path **must** carry a number in
 * `ANONYMOUS_LIMITS` below. The limiter does not default a missing one —
 * `middleware/rate-limit.ts:81` skips any endpoint absent from `anonymousLimits`,
 * so a public route with no number is not "unthrottled by default", it is
 * *unbounded*, and nothing anywhere says so.
 *
 * That hole was papered over once. `SCHEMA_REGISTRY` sat in the
 * `KNOWN_UNDECLARED` exemption list of `wrangler-config.contract.test.ts` and the
 * exemption was the bug: the binding was absent from the config, the guard was
 * silenced to accommodate it, and every event POST answered 500 for a reason
 * nobody could find. So this list has no exemption list of its own. Every entry is
 * covered by `support-limits.contract.test.ts`, and a new one without a number
 * fails the build.
 *
 * Prefixes are deliberately **not** in here, and so cannot be checked by it:
 * `/v1/auth/*` and `WEBHOOK_PREFIX` each cover routes with genuinely different
 * costs, and `PUT /v1/customers` is unbounded on purpose. A rule that had to
 * exempt those three would be the same shape as the exemption that hid the last
 * bug. The rule is scoped to what is scoped.
 *
 * ## The second half of a public path's contract, and where it is checked
 *
 * Being in this set says the gateway does not authenticate the request. It says
 * nothing about whether the **worker** does, and a path that is public here and
 * authenticated there answers 403 in every deployment — a route registered
 * correctly, tested green, and unreachable. That has now happened five times in
 * this repository, and `wrangler-route-reachability.contract.test.ts` guards the
 * gateway's half of it (does a prefix forward this path?) without touching this
 * one. `worker-public-path-auth.contract.test.ts` guards this half: every path
 * here, and every path under `WEBHOOK_PREFIX`, must be exempted by the worker
 * that serves it.
 */
export const EXACT_PUBLIC_PATHS: readonly string[] = Object.freeze([
  WALLET_CALLBACK_PATH,
  SUPPORT_PATH,
  PAYMENT_WEBHOOK_PATH,
]);

/**
 * Limits for the anonymous routes that have one, per client address.
 *
 * Exported so the coverage of `EXACT_PUBLIC_PATHS` is assertable directly rather
 * than only inferred from a 429. See that set's entry for why every one of them
 * has to appear here.
 */
export const ANONYMOUS_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  '/v1/auth/business/signup': SIGNUP_LIMIT_PER_WINDOW,
  // The terminal exchange is the same shape signup is and was, for the same
  // reason: public by prefix, so it arrives at the limiter with no `jwt`, no
  // `business_id` to key on, and — because it is absent here — no limit at all.
  // `middleware/rate-limit.ts:81` skips an endpoint the table does not name, which
  // is not "not throttled by default" but *unbounded*, and each call runs a
  // 100k-iteration key derivation to compare a presented secret. Five for signup
  // was enough for that cost on a public form; it is enough here.
  //
  // Not login's deliberate unlimited, and the asymmetry is the product. A limit on
  // login hands a legitimate person a 429 because someone else guessed at their
  // password, and they cannot tell that apart from being locked out. A till
  // authenticates once per boot — a loop against this endpoint is a bug at the
  // terminal, not traffic — so bounding it costs a merchant nothing real and
  // removes an amplifier from an unauthenticated path.
  '/v1/auth/pos/token': POS_TOKEN_LIMIT_PER_WINDOW,
  [WALLET_CALLBACK_PATH]: WALLET_CALLBACK_LIMIT_PER_WINDOW,
  // Three a minute for the support form. A person writes one message, and a
  // second attempt after a validation slip is the only legitimate repeat.
  //
  // Set low, unlike the callback's 600, because the cost being bounded is
  // different in kind. The callback's limit exists to stop an unauthenticated
  // request burning two ECDSA verifications; this one exists to stop an inbox
  // becoming unreadable, which is not a CPU cost and does not recover on its own.
  // A wrong guess about a pass balance is fixed by a sweep; a support inbox full
  // of spam is not fixed by anything except a limit, and the real customers stop
  // being read.
  [SUPPORT_PATH]: SUPPORT_LIMIT_PER_WINDOW,
  // The payment rail's settlement receiver. Same shape as the wallet callback —
  // unauthenticated, third party, retries with backoff, all deliveries from one
  // address — and a per-window number per client address is what bounds it.
  //
  // Set at the callback's 600 rather than the support form's 3 because the thing
  // being bounded is CPU and amplification, exactly as it is there, and the
  // direction of the error is asymmetric: too tight drops real settlements and
  // leaves a customer's loyalty unrecorded with no error here to explain it, while
  // too loose bounds a forgery campaign that the signature already stops.
  //
  // What this number is **not** is the thing standing between an attacker and a
  // written row — that is the signature. An unsigned or badly-signed delivery is
  // refused before any table is touched, so this is a ceiling on what an
  // unauthenticated caller can spend, not an authorization decision.
  [PAYMENT_WEBHOOK_PATH]: PAYMENT_WEBHOOK_LIMIT_PER_WINDOW,
});

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
      //
      // `ANONYMOUS_LIMITS` rather than an inline literal, so
      // `support-limits.contract.test.ts` can assert that every path in
      // `EXACT_PUBLIC_PATHS` has a number without reaching into a request. An
      // exemption list is not provided for, and must not be added: the last hole
      // in this middleware was closed by putting a name in one.
      anonymousLimits: ANONYMOUS_LIMITS,
      windowSeconds: DEFAULT_WINDOW,

  })(c, next);
});

// Middleware 5: Route dispatch to service bindings
app.use('/v1/*', routerMiddleware);

// ---------------------------------------------------------------------------
// Event ingestor — authenticated
// ---------------------------------------------------------------------------
//
// Registered **below** the five middlewares above, and that position is the
// authentication.
//
// This used to be mounted at `/` before any of them, carrying its own full
// `/v1/events/:type` path. Hono runs handlers in registration order, so the
// route answered before auth, auth-inject, business-id and rate-limit ever ran:
// an unauthenticated public write, with the tenant taken from the request body.
// Its tests passed because they called it without a token — they were asserting
// the hole.
//
// `/v1/events` stays in `ROUTE_MAP` as a `gateway` binding; `routerMiddleware`
// calls `next()` for that binding rather than 404-ing, which is how a route this
// worker answers itself is reachable at all.
app.route('/v1/events', ingestor);

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
//
// The customer-web base is read per request and normalised here, so
// `renderMerchantPage` never sees a raw configured string and the one link on
// this page is built from a value this mount point is responsible for.
app.get(
  '/p/*',
  async (c) =>
    merchantPageRoute(createMerchantPageReader(c.env), {
      customerWebBaseUrl: parseCustomerWebBaseUrl(c.env.WALLET_CUSTOMER_WEB_BASE_URL),
    })(c),
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
// The support channel
// ---------------------------------------------------------------------------

// Registered **after** the five `/v1/*` middlewares and reached *through* them,
// which is the whole arrangement. It needs the rate limiter to run, and the rate
// limiter only exists under that prefix.
//
// It still needs a `ROUTE_MAP` entry with `binding: 'gateway'`, because
// `routerMiddleware` 404s any `/v1/*` path no prefix matches instead of calling
// `next()` — so without that entry this handler would be unreachable in every
// environment, which is exactly what happened to the wallet service binding when
// it had no route. `src/support.ts` has the reasoning; this is the ingestor's
// arrangement, reused.
app.post(
  SUPPORT_PATH,
  supportRoute({
    fetch: (...args) => fetch(...args),
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  }),
);

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

/**
 * The path, with no query string.
 *
 * A query string is where credentials live — `?token=`, `?code=` for an OAuth
 * exchange, `?signature=` — and `wrangler tail` retains logs where anyone with
 * dashboard access can read them. The pathname is what triage actually needs to
 * identify the failing route, and it carries no credential, so that is all this
 * logs. Reaching for `c.req.url` here would put the full query into an error log
 * on every 500, which is the exact leak the next paragraph exists to prevent.
 */
function logPathname(c: Context<{ Bindings: GatewayEnv }>): string {
  return new URL(c.req.url).pathname;
}

app.onError((err, c) => {
  // One value, used for both the response and the log. Generating a second UUID
  // for either side is the bug this replaces: the client was handed an id that
  // existed nowhere but the response body, so `wrangler tail --search <id>` came
  // back empty and the id could not be tied to anything. A `request_id` nobody
  // can find is worse than none, because the user is told to report it.
  const requestId = crypto.randomUUID();

  // Built before logging so the status in the log is read off the response that
  // is actually going out. Logging a literal 500 here would be true today and
  // silently wrong the day a handler returns a different status after throwing.
  const response = c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        request_id: requestId,
      },
    },
    500,
  );

  // ## What is deliberately absent
  //
  // No headers, no cookies, no request body. This is the gateway: it carries a
  // customer's `Authorization: Bearer`, session cookies and card-adjacent JSON
  // for every tenant on the platform, and an error handler is the single place
  // that sees all of it at once. Serialising the request "for context" would
  // write live customer credentials into retained logs on every 500 — and an
  // error log is exactly the thing that gets copied into an issue, a pastebin
  // and a support ticket. Method, path, status and the error itself are what
  // triage needs; a token would help nobody and would outlive the incident.
  //
  // The error object is logged as a second argument rather than interpolated, so
  // its stack survives instead of being flattened into `String(err)`.
  console.error(
    `[gateway] request_id=${requestId} ${c.req.method} ${logPathname(c)} ${response.status}:`,
    err,
  );

  return response;
});

export default app;
