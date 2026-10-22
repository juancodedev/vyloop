import type { KVNamespace } from '@cloudflare/workers-types';
import { getRequestId, logPrefix } from '@vyloop/request-context';
import type { Context, Next } from 'hono';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServiceBinding {
  /** The Workers service binding name (e.g. 'identity', 'customer', 'growth') */
  binding: string;
  /** The URL prefix to match (e.g. '/v1/auth') */
  prefix: string;
}

/** Route map: URL prefix → service binding name */
export const ROUTE_MAP: ServiceBinding[] = [
  { prefix: '/v1/auth', binding: 'identity' },
  { prefix: '/v1/me', binding: 'identity' },
  { prefix: '/v1/businesses', binding: 'identity' },
  // The identity worker owns the customer's consent endpoints even though
  // they live under the broader customer namespace.
  { prefix: '/v1/customers/me/consents', binding: 'identity' },
  { prefix: '/v1/customers', binding: 'customer' },
  { prefix: '/v1/loyalty', binding: 'growth' },
  { prefix: '/v1/growth', binding: 'growth' },
  { prefix: '/v1/analytics', binding: 'analytics' },
  { prefix: '/v1/events', binding: 'gateway' }, // handled by ingestor
  // The support channel on the card screen, handled by this worker too, for the
  // same reason as `/v1/events`: `routerMiddleware` 404s any `/v1/*` path that no
  // prefix matches rather than calling `next()`, so a route the gateway answers
  // itself still has to be named here to be reachable.
  //
  // Longest-prefix match sorts `/v1/support` (12) above `/v1/auth` (8) and
  // alongside `/v1/events`, so nothing else can claim it. Without this entry the
  // route exists, is public, and answers 404 from the gateway — a failure that
  // looks identical to the route not existing, which is what the wallet service
  // binding did for as long as it had no route.
  { prefix: '/v1/support', binding: 'gateway' },
  { prefix: '/v1/automation', binding: 'automation' },
  { prefix: '/v1/communication', binding: 'communication' },
  { prefix: '/v1/compliance', binding: 'compliance' },
  // The wallet service binding was already declared in `wrangler.jsonc` but had
  // no route, so the worker's routes were unreachable in any environment. The
  // prefix is listed last because `matchRoute` sorts by length anyway, and the
  // entry sits with the other leaf services.
  { prefix: '/v1/wallet', binding: 'wallet' },
];

/**
 * Find the service binding for a given URL path.
 *
 * Returns the first matching prefix (longest-prefix match via sorted order).
 *
 * ## Why the match is on a segment boundary and not on `startsWith`
 *
 * `/v1/loyalty` is a *namespace*, not the four-character string that happens to
 * open it. A bare `startsWith` also matches `/v1/loyalty-admin` and
 * `/v1/loyalty-anything-else`, and forwards them to the growth worker — so a
 * path that belongs to no service answers as though it belonged to that one,
 * and the route the worker serves is 404 while the answer comes from the wrong
 * file.
 *
 * No such path exists today, which is why this sat latent: every route in the
 * fleet is either exactly its prefix or continues with `/`. That is a property
 * of today's route list, not of the router, and the failure it would produce is
 * the one this module already has a history of. Two occurrences of it are
 * recorded above, and the third was `POST /v1/checkins`, which was complete,
 * tested, merged and deployed before anything could reach it.
 *
 * So the boundary is enforced here rather than trusted to the route list, and
 * `wrangler-route-reachability.contract.test.ts` asserts every worker's routes
 * still resolve under the stricter rule.
 */
export function matchRoute(path: string): ServiceBinding | undefined {
  // Sort by prefix length descending for longest-prefix match
  const sorted = [...ROUTE_MAP].sort((a, b) => b.prefix.length - a.prefix.length);
  return sorted.find(
    (route) => path === route.prefix || path.startsWith(`${route.prefix}/`),
  );
}

// ---------------------------------------------------------------------------
// Env type for service bindings
// ---------------------------------------------------------------------------

export type GatewayEnv = {
  JWT_SECRET: string;
  /**
   * Neon connection string, injected by the deploy job as a plain var — the same
   * one `identity`, `wallet` and `growth` receive, and not a secret.
   *
   * Present for `/p/{slug}` only: that page resolves a slug to a tenant and
   * reads its loyalty programme. It is not reached through a service binding
   * because every `/v1/*` route requires a JWT and this page is public by
   * requirement. See `apps/gateway/src/merchant-store.ts` for why the read has to
   * resolve the tenant before arming RLS.
   */
  DATABASE_URL: string;
  /**
   * The `apps/customer-web` origin, for the one link on `/p/{slug}`.
   *
   * Present for `/p/{slug}` only, and **not** interchangeable with the two hosts
   * this worker already reaches for. `/p/*` and `/brand/*` are gateway routes;
   * `/register` and `/profile` are `apps/customer-web` pages that this worker
   * does not serve. So the CTA's host has to be named separately — putting the
   * link on `media.juancode.dev` would render a page that looks correct and a
   * link that 404s, which is the `programLogo` defect at a different URL and
   * already cost one class review.
   *
   * Optional with a documented default (`parseCustomerWebBaseUrl`), because there
   * is one correct host for this platform and a blank var is a default to apply
   * rather than a misconfiguration to report. It is still declared in
   * `wrangler.jsonc`, which is where every non-secret value this worker reads
   * lives; a deploy `--var` merges into that map rather than replacing it, so
   * `JWT_SECRET` and `DATABASE_URL` arrive as flags without displacing it. The
   * default is the floor, not the mechanism.
   */
  WALLET_CUSTOMER_WEB_BASE_URL?: string | undefined;
  /**
   * Resend bearer token, for the public support form at `POST /v1/support`.
   *
   * A secret, so it arrives through the deploy job's `--var` flags rather than
   * `wrangler.jsonc` — see the header of that file for the split, which is by
   * sensitivity and nothing else.
   *
   * **Does not exist in any environment yet**, and the route fails closed
   * without it: `src/support.ts` answers 503 and sends nothing. That is the
   * intended state rather than a gap to paper over — an unverified key is worse
   * than an absent one, because it would make the channel look deployed while
   * delivering nothing.
   */
  RESEND_API_KEY?: string | undefined;
  /**
   * The verified Resend domain the support mail is sent from.
   *
   * Not a secret, and still not declared in `wrangler.jsonc`: a domain has to be
   * *verified* in the Resend console before Resend will accept it, and none is
   * verified for this project. A plausible-looking literal in the config would
   * satisfy `wrangler-config.contract.test.ts` and every behavioural test while
   * making every send fail with a 422 — the exact shape of the
   * `SCHEMA_REGISTRY` bug, where a declared-but-wrong value answers correctly and
   * wrongly at the same time.
   *
   * So it is a workflow flag, and absent means 503 with nothing sent.
   */
  SUPPORT_EMAIL_FROM?: string | undefined;
  /**
   * The inbox a human reads. Declared in `wrangler.jsonc` as a plain var, because
   * there is exactly one correct answer for it and nothing secret about it.
   */
  SUPPORT_EMAIL_TO?: string | undefined;
  /**
   * Turnstile widget secret, for the same form.
   *
   * **The check is not optional.** `src/support.ts` refuses to send when this is
   * absent rather than skipping verification, because a skip is invisible: the
   * form would work, the inbox would fill with spam, and no log anywhere would say
   * the protection had never run. Failing closed is the only behaviour that makes
   * the state visible.
   *
   * No widget has been created for this project, so this is unset everywhere and
   * the form is non-functional. That is reported rather than worked around.
   */
  TURNSTILE_SECRET_KEY?: string | undefined;
  RATE_LIMITER: KVNamespace;
  /**
   * Static assets from `apps/gateway/public/`, declared by the `assets` block in
   * `wrangler.jsonc`. Used only to serve `robots.txt`; see `robots.ts` for why
   * that one file is worth a Worker route.
   */
  ASSETS?: Fetcher;
  /** Private bucket of brand assets, served publicly through /brand/*. */
  BRAND_ASSETS: R2Bucket;
  SCHEDULER: Queue;
  SCHEMA_REGISTRY: KVNamespace;
  EVENT_QUEUE: Queue;
  DOMAIN_EVENTS_QUEUE: Queue;
  // Service bindings — named per worker in wrangler.jsonc
  identity: Fetcher;
  customer: Fetcher;
  growth: Fetcher;
  analytics: Fetcher;
  automation: Fetcher;
  communication: Fetcher;
  compliance: Fetcher;
  wallet: Fetcher;
};

/**
 * Hono middleware that dispatches requests to the appropriate service binding.
 *
 * Must run AFTER auth, business-id, and rate-limit middleware.
 */
export async function routerMiddleware(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;
  const route = matchRoute(path);

  if (!route) {
    return c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: `No route found for path: ${path}`,
          request_id: getRequestId(c),
        },
      },
      404,
    );
  }

  // If the route is 'gateway', handle internally (e.g., events)
  if (route.binding === 'gateway') {
    // Let internal handlers process this (events ingestor etc.)
    await next();
    return;
  }

  // Forward to the service binding
  const env = c.env as Record<string, unknown>;
  const binding = env[route.binding] as Fetcher | undefined;

  if (!binding) {
    return c.json(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: `Service binding "${route.binding}" not configured`,
          request_id: getRequestId(c),
        },
      },
      503,
    );
  }

  try {
    // Forward the request, preserving method, headers, and body
    const request = c.req.raw;
    const response = await binding.fetch(request);
    return response;
  } catch (err) {
    console.error(`${logPrefix('gateway', getRequestId(c))} routing error to ${route.binding}:`, err);
    return c.json(
      {
        error: {
          code: 'SERVICE_ERROR',
          message: `Error forwarding to ${route.binding}`,
          request_id: getRequestId(c),
        },
      },
      502,
    );
  }
}
