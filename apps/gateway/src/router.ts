import type { KVNamespace } from '@cloudflare/workers-types';
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
  { prefix: '/v1/customers', binding: 'customer' },
  { prefix: '/v1/loyalty', binding: 'growth' },
  { prefix: '/v1/growth', binding: 'growth' },
  { prefix: '/v1/analytics', binding: 'analytics' },
  { prefix: '/v1/events', binding: 'gateway' }, // handled by ingestor
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
 */
export function matchRoute(path: string): ServiceBinding | undefined {
  // Sort by prefix length descending for longest-prefix match
  const sorted = [...ROUTE_MAP].sort((a, b) => b.prefix.length - a.prefix.length);
  return sorted.find((route) => path.startsWith(route.prefix));
}

// ---------------------------------------------------------------------------
// Env type for service bindings
// ---------------------------------------------------------------------------

export type GatewayEnv = {
  JWT_SECRET: string;
  RATE_LIMITER: KVNamespace;
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
          request_id: crypto.randomUUID(),
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
          request_id: crypto.randomUUID(),
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
    console.error(`Routing error to ${route.binding}:`, err);
    return c.json(
      {
        error: {
          code: 'SERVICE_ERROR',
          message: `Error forwarding to ${route.binding}`,
          request_id: crypto.randomUUID(),
        },
      },
      502,
    );
  }
}
