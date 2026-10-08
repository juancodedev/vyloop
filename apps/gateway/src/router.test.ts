// @vitest-environment node

/**
 * `matchRoute` decides which worker serves a request, so its two failure modes
 * are the two that cost the most.
 *
 * A prefix that **matches too little** hands the path to nothing: the router
 * answers 404 for an unmatched `/v1/*` path rather than falling through, and a
 * route the worker serves perfectly well becomes unreachable. That happened
 * three times in this repo — `wallet` had no `ROUTE_MAP` entry at all,
 * `/v1/support` was answered by the gateway worker and still needed one, and
 * `POST /v1/checkins` shipped complete, tested and deployed before anything
 * could reach it. `wrangler-route-reachability.contract.test.ts` covers that
 * direction, and this file is deliberately not a second copy of it.
 *
 * A prefix that **matches too much** is the quieter one, and it is what this
 * file exists for. `/v1/loyalty` is a namespace, not the string that opens it:
 * under a bare `startsWith`, `/v1/loyalty-admin` resolves to the growth worker
 * and is forwarded there, so the 404 comes from the wrong file and reads as
 * "that service does not have that route" rather than as "nothing claims this
 * path". No such path exists today, which is exactly why it can sit there
 * unnoticed — every route in the fleet is either exactly its prefix or
 * continues with `/`, so the route list happens to satisfy a rule the router
 * does not enforce.
 *
 * That is why the reachability guard is not sufficient evidence for the
 * boundary. Reverting `matchRoute` to `startsWith` leaves every registered
 * route resolving, so that guard stays green; only a test that asserts a path
 * the boundary must reject can see the difference.
 */

import { describe, expect, it } from 'vitest';

import { matchRoute, ROUTE_MAP } from './router';

describe('matchRoute matches a prefix on a segment boundary', () => {
  it.each([
    { path: '/v1/loyalty-admin', note: 'a hyphenated sibling of /v1/loyalty' },
    { path: '/v1/loyaltyadmin', note: 'the same word with the separator gone' },
    { path: '/v1/authx/login', note: 'a sibling of /v1/auth' },
    { path: '/v1/customers-v2/me', note: 'a versioned sibling of /v1/customers' },
    { path: '/v1/support-admin', note: 'a sibling of the gateway-owned prefix' },
  ])('refuses $path — $note', ({ path }) => {
    expect(matchRoute(path)).toBeUndefined();
  });

  it.each([
    { path: '/v1/loyalty', binding: 'growth', note: 'the prefix itself' },
    { path: '/v1/loyalty/', binding: 'growth', note: 'the prefix with a trailing slash' },
    { path: '/v1/loyalty/checkins', binding: 'growth', note: 'a child route' },
    { path: '/v1/loyalty/passes/resolve', binding: 'growth', note: 'a nested child route' },
    { path: '/v1/auth/login', binding: 'identity', note: 'a child of a multi-prefix binding' },
    { path: '/v1/customers/me', binding: 'customer', note: 'a reserved word as a segment' },
    { path: '/v1/wallet/google/callback', binding: 'wallet', note: 'a deep nested child route' },
  ])('resolves $path to $binding — $note', ({ path, binding }) => {
    expect(matchRoute(path)?.binding).toBe(binding);
  });

  it('resolves every path that shares a string with two prefixes to the longer one', () => {
    // `/v1/loyalty` and `/v1/loyalty-admin` are the same characters for nine
    // positions. If the boundary ever goes back to `startsWith`, whichever
    // prefix happens to sort first wins, and it is not the one anyone meant.
    expect(matchRoute('/v1/loyalty/config')?.binding).toBe('growth');
    expect(matchRoute('/v1/loyalty-admin')).toBeUndefined();
  });

  it('gives every declared prefix a resolution at the prefix and at one child', () => {
    // The property the fleet depends on, asserted over `ROUTE_MAP` rather than
    // over a hand-copied list, so a prefix added later is covered without an
    // edit here. A prefix with a trailing slash would make
    // `${prefix}/` contain a doubled separator and silently match nothing but
    // the exact string, which is what this catches.
    for (const route of ROUTE_MAP) {
      expect(route.prefix.endsWith('/'), `${route.prefix} has a trailing slash`).toBe(false);
      expect(matchRoute(route.prefix)?.binding, `${route.prefix} does not resolve itself`).toBe(
        route.binding,
      );
      expect(
        matchRoute(`${route.prefix}/probe`)?.binding,
        `${route.prefix} does not resolve a child path`,
      ).toBe(route.binding);
    }
  });

  it('keeps the longest prefix winning where two could claim a path', () => {
    // The growth worker owns two prefixes, `/v1/loyalty` and `/v1/growth`, and
    // the sort exists for exactly this. Sorting by length descending is what
    // makes a nested prefix beat its parent.
    const overlapping = ROUTE_MAP.filter((route) =>
      ROUTE_MAP.some(
        (other) => other !== route && route.prefix.startsWith(`${other.prefix}/`),
      ),
    );
    for (const inner of overlapping) {
      const outer = ROUTE_MAP.find(
        (candidate) => candidate.prefix !== inner.prefix && inner.prefix.startsWith(candidate.prefix),
      );
      if (!outer) continue;
      expect(matchRoute(inner.prefix)?.binding).toBe(inner.binding);
    }
  });
});
