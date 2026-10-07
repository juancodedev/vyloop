import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import {
  POS_TOKEN_LIMIT_PER_WINDOW,
  SIGNUP_LIMIT_PER_WINDOW,
  rateLimitMiddleware,
} from './rate-limit';

// ---------------------------------------------------------------------------
// The number for the terminal token exchange, asserted apart from the wiring.
//
// `ANONYMOUS_LIMITS` and the end-to-end 429 live in `index.test.ts`, which drives
// the real app. This file covers the two things that test cannot see well: that
// the number is *named* rather than a literal at its use site, and that a public
// credential route is bounded by the same anonymous branch while login is still
// deliberately unbounded.
// ---------------------------------------------------------------------------

/** A KV stub that always reports `count` as the stored counter. */
function kvReporting(count: number) {
  return {
    get: async () => String(count),
    put: async () => {},
    delete: async () => {},
  };
}

/**
 * One anonymous request through the limiter.
 *
 * No `jwt` is set on the context, which is the whole shape of an `/v1/auth/*`
 * request: the auth middleware skips the path, so nothing is put there for the
 * limiter to read and it takes the `anonymousLimits` branch.
 *
 * `count` is the stored counter, so the caller decides whether this request lands
 * inside or outside the ceiling. `limit` is the anonymous table, so passing one
 * without an entry reproduces the "route absent from the table" case exactly.
 */
async function anonymousRequest({
  path,
  count,
  limit,
}: {
  path: string;
  count: number;
  limit: Record<string, number>;
}) {
  const middleware = rateLimitMiddleware({
    kv: kvReporting(count) as never,
    limits: {},
    windowSeconds: 60,
    anonymousLimits: limit,
  });

  const hono = new Hono();
  hono.use('*', middleware);
  let routeRan = false;
  hono.all('*', (c) => {
    routeRan = true;
    return c.text('reached the route');
  });

  const res = await hono.fetch(new Request(`https://api.test${path}`, { method: 'POST' }));
  return { status: res.status, headers: res.headers, routeRan };
}

describe('POS_TOKEN_LIMIT_PER_WINDOW', () => {
  it('is five, which is what signup gets for the same cost', () => {
    // Both routes are public, both are keyed only by client address because the
    // caller has no `business_id` yet, and both run a 100k-iteration key derivation
    // before they can answer. One derivation per request with no ceiling is an
    // amplifier pointed at us, so the two share a number deliberately rather than
    // by accident.
    expect(POS_TOKEN_LIMIT_PER_WINDOW).toBe(5);
    expect(POS_TOKEN_LIMIT_PER_WINDOW).toBe(SIGNUP_LIMIT_PER_WINDOW);
  });

  it('is a number rather than a string, so the limiter can compare it', () => {
    // The middleware evaluates `count >= limit` against a `number`. A string
    // constant would compare lexicographically and refuse every caller instead of
    // bounding them.
    expect(typeof POS_TOKEN_LIMIT_PER_WINDOW).toBe('number');
  });

  it('refuses the token exchange once the counter reaches it, without running the route', async () => {
    const { status, headers, routeRan } = await anonymousRequest({
      path: '/v1/auth/pos/token',
      count: POS_TOKEN_LIMIT_PER_WINDOW,
      limit: { '/v1/auth/pos/token': POS_TOKEN_LIMIT_PER_WINDOW },
    });

    expect(status).toBe(429);
    expect(headers.get('Retry-After')).toBe('60');
    // A 429 that arrived *after* the handler ran would bound nothing, so the
    // route must not have been reached at all.
    expect(routeRan).toBe(false);
  });

  it('lets a till through below the ceiling, because it authenticates once', async () => {
    const justUnder = await anonymousRequest({
      path: '/v1/auth/pos/token',
      count: POS_TOKEN_LIMIT_PER_WINDOW - 1,
      limit: { '/v1/auth/pos/token': POS_TOKEN_LIMIT_PER_WINDOW },
    });

    expect(justUnder.status).toBe(200);
    expect(justUnder.routeRan).toBe(true);
  });

  it('is unbounded only because the table names it — an unnamed public path is not', async () => {
    // The reason the entry has to exist at all. The limiter's branch is
    // `anonymousLimit === undefined -> next()`, so a route missing from the table
    // is not "unthrottled by default", it is *unbounded*, and nothing else in the
    // gateway says so. Reproduced here so the failure this fix closes is visible
    // as a behaviour rather than described in a comment.
    const unnamed = await anonymousRequest({
      path: '/v1/auth/pos/token',
      count: 9999,
      limit: {},
    });

    expect(unnamed.status).toBe(200);
    expect(unnamed.routeRan).toBe(true);
  });

  it('leaves login unbounded, which is the asymmetry this file exists to pin', async () => {
    // Not an oversight, and not an oversight by omission: login has no entry in the
    // anonymous table at all, so the `undefined` branch lets it through. A limit
    // there hands a legitimate person a 429 because someone else guessed at their
    // password, and they cannot tell that from being locked out of their account.
    const { status, routeRan } = await anonymousRequest({
      path: '/v1/auth/login',
      count: 9999,
      limit: {},
    });

    expect(status).toBe(200);
    expect(routeRan).toBe(true);
  });
});