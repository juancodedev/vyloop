/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { WALLET_CALLBACK_PATH } from './robots';

import app, { isPublicApiPath } from './index';

// ---------------------------------------------------------------------------
// The cross-package drift guard for the Google Wallet callback path
// ---------------------------------------------------------------------------
//
// ## What this file is for
//
// `/v1/wallet/google/callback` is a string that has to be agreed on by two
// packages that cannot see each other. The **gateway** exempts it from auth,
// keys a rate limit on it and forwards it over the `wallet` service binding. The
// **wallet worker** serves it and verifies Google's signature on it. Google
// POSTs to whatever URL `provision.ts` handed it when the class was created, so
// there is a third consumer of the same string that lives in neither package's
// code.
//
// ## Why this reads the worker's source instead of importing it
//
// `apps/gateway` does not depend on `@vyloop/wallet`, and that is correct rather
// than incidental: the gateway is the public face and the worker is the service
// behind it. Adding a runtime edge from the public face to the service behind it,
// so that a test can compare two strings, inverts the dependency direction of
// the whole system to buy a compile-time check.
//
// So this guard reads `workers/wallet/src/routes.ts` and extracts the constant
// **by name** — the same shape `wrangler-config.contract.test.ts` uses to read
// `wrangler.jsonc` instead of importing it. That precedent is the point: this is
// not a workaround invented here, it is how this repository asserts across a
// package boundary it refuses to create.
//
// A future reader will find this ugly and try to "fix" it with
// `import { WALLET_CALLBACK_PATH } from '@vyloop/wallet'`. That import is the
// bug. The test would still pass, the dependency graph would point backwards,
// and `apps/gateway` could no longer be reasoned about without a worker package
// that drags in drizzle and the Google client.
//
// ## Why there is more here than an equality
//
// An equality between two strings that currently agree proves nothing until the
// moment it matters, and the moment it matters is a rename. So this file also
// holds the two halves a rename can break **quietly**:
//
// 1. The worker must **declare** the path by name, in the module that registers
//    the route. With only a literal there is nothing stable to extract, and the
//    guard would have to scrape a bare string out of a `router.post(...)` call —
//    which is why the constant had to exist before the guard could be written.
// 2. The registration must go **through** that constant. A worker that goes back
//    to a literal serves the right path today and stops agreeing with the guard
//    tomorrow, and a guard that has quietly lost sight of a route is the same
//    silent delivery failure this file exists to prevent.
//
// ## What the failure looks like in production
//
// A one-sided rename does not throw. The gateway keeps forwarding to a path the
// worker no longer serves, and Google's signed POST comes back `404` from a
// webhook nobody is watching. `customer_wallet_passes.state` then goes on
// reporting whatever the last reconcile inferred, which is indistinguishable from
// a customer who never opened the app — so the bug is invisible from both ends
// and only surfaces when a merchant asks why a pass stopped updating.

const WALLET_SRC = join(__dirname, '..', '..', '..', 'workers', 'wallet', 'src');

/**
 * The worker's `routes.ts`, read once.
 *
 * `routes.ts` and not `index.ts` on purpose: it is the module that calls
 * `router.post`, so it is the only file where the declaration and its use can be
 * asserted together. `index.ts` re-exports the constant for its own auth
 * exemption and would happily satisfy this guard while `routes.ts` went on
 * serving a literal.
 */
const routesSource = readFileSync(join(WALLET_SRC, 'routes.ts'), 'utf8');

/** The path the worker declares, by name. `undefined` when there is no constant. */
function workerDeclaredPath(): string | undefined {
  return /export const WALLET_CALLBACK_PATH = '([^']*)'/.exec(routesSource)?.[1];
}

/**
 * Every route path registered in the worker's router, **as written**.
 *
 * A capture of the source text of each first argument rather than an imported
 * value, so that `WALLET_CALLBACK_PATH` and `'/v1/wallet/google/callback'` stay
 * distinguishable. Reading the imported routes instead would collapse both to the
 * same string and make the "no literal" assertion unexpressible — and that
 * assertion is the one that catches a regression rather than a rename.
 */
function registeredRoutePaths(): string[] {
  return [...routesSource.matchAll(/router\.(?:get|post|put|patch|delete)\(\s*([^,)]+?)\s*,/g)].map(
    (match) => match[1],
  );
}

/** Minimal bindings for a request that has to clear the middleware chain. */
function mockEnv(overrides: Record<string, unknown> = {}) {
  return {
    JWT_SECRET: 'test-jwt-secret-key-for-unit-tests-only',
    RATE_LIMITER: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    wallet: {
      fetch: async () => new Response('{}', { status: 200 }),
    },
    ...overrides,
  };
}

describe('the wallet callback path agrees across packages', () => {
  it('is declared by name in the worker module that registers the route', () => {
    // The precondition for every other assertion here. A guard that had to scrape
    // a literal out of `router.post('/…')` is one refactor away from matching a
    // path nobody serves, so the constant is asserted to exist first and on its
    // own: this failure says what is missing, instead of reporting a bogus
    // mismatch between two values the guard had to invent.
    expect(workerDeclaredPath()).toBeDefined();
    expect(routesSource).toMatch(/export const WALLET_CALLBACK_PATH = '\/v1\/[^']+';/);
  });

  it('is the same string the worker declares, whichever side moved', () => {
    // `toBe` on two independently sourced values, so this fails in **both**
    // directions: rename the worker's constant and it fails, rename the
    // gateway's and it fails. It cannot be satisfied by one side matching the
    // other, nor by either matching a literal written inside this test — the
    // expected value is read out of the worker and never repeated here.
    const declared = workerDeclaredPath();

    expect(declared).toBeDefined();
    expect(WALLET_CALLBACK_PATH).toBe(declared);
  });

  it('registers the worker route from the constant, not from a literal', () => {
    // The direction of the rename is invisible to the equality above: a worker
    // serving `'/v1/wallet/google/callback'` inline and a gateway forwarding to
    // the same string are perfectly equal, and perfectly one refactor away from
    // not being. So the registration itself is inspected, and both halves are
    // required — the constant is used, and the raw path is not a route anywhere
    // in the router.
    const declared = workerDeclaredPath();
    expect(declared).toBeDefined();

    const registered = registeredRoutePaths();

    expect(registered, 'the callback route must be registered from the constant').toContain(
      'WALLET_CALLBACK_PATH',
    );
    expect(registered, 'no route may be registered from the raw path').not.toContain(
      `'${declared}'`,
    );
  });
});

describe('the callback stays public, exactly', () => {
  it('is public on POST, because Google has no token to send', () => {
    // Read off the predicate rather than inferred from a request, so the claim
    // and the code making it cannot be two different statements. The exemption is
    // what lets an unsigned request reach the worker at all; if it ever narrowed,
    // every real delivery would 401 with a message about missing headers — which
    // from the outside is exactly what a rejected signature looks like.
    expect(isPublicApiPath(WALLET_CALLBACK_PATH, 'POST')).toBe(true);
  });

  it('is not public on anything appended below it', () => {
    // An exact comparison, not a prefix. A prefix would exempt
    // `/v1/wallet/google/callback/admin` and every path appended later, and a
    // hole in the auth middleware looks exactly like a feature until something
    // real gets routed underneath it.
    for (const path of [
      `${WALLET_CALLBACK_PATH}/admin`,
      `${WALLET_CALLBACK_PATH}/`,
      `${WALLET_CALLBACK_PATH}x`,
      '/v1/wallet/google',
    ]) {
      expect(isPublicApiPath(path, 'POST'), path).toBe(false);
    }
  });

  it('does not treat a query string as a different route', async () => {
    // Not a hole, and asserted through `app.fetch` rather than through the
    // predicate on purpose. `isPublicApiPath` is handed `pathname`, which has
    // already had the query stripped, so calling it with `?x=1` would be probing
    // input the function never receives — it would return `false` and prove
    // nothing about the request. The property that matters is that a real request
    // carrying a query string still matches the exemption and still reaches the
    // worker, which is what a switch from `c.req.url` to `pathname` would break.
    const wallet = { fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) };

    const res = await app.fetch(
      new Request(`https://api.test${WALLET_CALLBACK_PATH}?x=1`, { method: 'POST', body: '{}' }),
      mockEnv({ wallet }) as never,
    );

    expect(res.status).toBe(200);
    expect(wallet.fetch).toHaveBeenCalledTimes(1);
  });

  it('leaves the customer wallet routes authenticated', () => {
    // Adding the callback to the public set must not widen anything else.
    for (const path of ['/v1/wallet/status', '/v1/wallet/pass']) {
      expect(isPublicApiPath(path, 'GET'), path).toBe(false);
      expect(isPublicApiPath(path, 'POST'), path).toBe(false);
    }
  });

  it('forwards an unsigned callback to the wallet worker instead of 401', async () => {
    // The end-to-end half. `isPublicApiPath` is one predicate shared by three
    // middlewares, so being correct about it is necessary but not sufficient: a
    // middleware that stopped consulting it would still 401 while every assertion
    // above stayed green.
    const res = await app.fetch(
      new Request(`https://api.test${WALLET_CALLBACK_PATH}`, { method: 'POST', body: '{}' }),
      mockEnv() as never,
    );

    expect(res.status).toBe(200);
  });
});

describe('the callback keeps an entry in the anonymous rate limit table', () => {
  it('is still limited, because a route absent from anonymousLimits is unlimited', async () => {
    // The limiter skips any path missing from `anonymousLimits` entirely, so a
    // rename that moved the exemption but not the table entry would leave a
    // public endpoint that runs two ECDSA verifications per request on an
    // attacker's behalf, with no ceiling at all. That failure is invisible from
    // the outside — the requests simply all succeed — so it is asserted here
    // against the path the constant names rather than against a literal that
    // would drift alongside the table.
    const rateLimiter = {
      get: async () => String(Number.MAX_SAFE_INTEGER),
      put: async () => {},
      delete: async () => {},
    };

    const res = await app.fetch(
      new Request(`https://api.test${WALLET_CALLBACK_PATH}`, { method: 'POST', body: '{}' }),
      mockEnv({ RATE_LIMITER: rateLimiter }) as never,
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
