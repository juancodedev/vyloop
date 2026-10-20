/// <reference types="node" />
// @vitest-environment node

/**
 * Every route a worker registers under the gateway's namespace is reachable
 * through the gateway.
 *
 * ## The bug this file exists to prevent
 *
 * `routerMiddleware` answers **404** for any `/v1/*` path that no `ROUTE_MAP`
 * prefix matches. It does not call `next()` and let the request fall through, so
 * "no prefix claims this path" is not a pass-through — it is a hard 404 served
 * by the gateway itself, with a `NOT_FOUND` body naming the path. A route the
 * worker registers and serves perfectly well can therefore be **completely
 * unreachable from outside that worker**, and the only symptom is a 404 that is
 * indistinguishable from the route not existing.
 *
 * This has now happened three times, in three different shapes:
 *
 * 1. The `wallet` service binding was declared in `wrangler.jsonc` with no route
 *    in `ROUTE_MAP`, so nothing it served was reachable in any environment.
 * 2. `/v1/support` is answered by the gateway worker itself rather than a
 *    binding, and still needed a `ROUTE_MAP` entry to be reachable — the comment
 *    above that entry and `support.ts:126` record it.
 * 3. `POST /v1/checkins` and `POST /v1/passes/resolve` were registered in
 *    `workers/growth/src/routes.ts` under prefixes nothing forwards. Both were
 *    fully implemented, fully covered by behavioural tests in the worker, and
 *    404 from the gateway in every environment.
 *
 * All three were invisible to the package that owned the route: the handler was
 * written, the tests were written, the tests were green, and the endpoint was
 * unreachable. **The worker cannot see the gateway's table**, so nothing inside
 * the worker can catch this.
 *
 * ## Why the scope is every worker and not just growth
 *
 * The first version of this guard covered `workers/growth` alone, on the
 * reasoning that growth is where the third bug was. That reasoning does not
 * survive contact with the table: `ROUTE_MAP` claims thirteen prefixes across
 * nine bindings, and `identity` alone owns three of them. A guard scoped to the
 * worker where a bug happened covers the next one by luck.
 *
 * So the rule is stated per worker, and it names that worker's **binding**, not
 * one prefix. `identity` is reachable through `/v1/auth`, `/v1/me` and
 * `/v1/businesses`; a worker legitimately gaining a second prefix later needs no
 * edit here, and only losing reachability does. The binding is the package
 * directory name, which is the convention `wrangler.jsonc` already follows, and
 * the precondition asserts that convention still holds rather than assuming it.
 *
 * ## Which workers are guarded, and which are not
 *
 * Guarded, because each registers at least one route: `identity`,
 * `analytics`, `customer`, `growth`, `wallet`, `communication`, `automation`.
 * The completeness assertion below re-derives that set from the filesystem on
 * every run, so a ninth worker that adds a route has to be added here — that is
 * the one way this guard can quietly shrink its own coverage, and it is closed.
 *
 * Not guarded, with the reason, rather than silently ignored:
 *
 * - **`/v1/events` and `/v1/support` are bound to `gateway`,** which is not a
 *   worker at all: those routes are served by `apps/gateway/src/` itself. No
 *   package under `workers/*` owns them, so there is nothing here for this file
 *   to extract. They are pinned by `wrangler-config.contract.test.ts` and
 *   `support-limits.contract.test.ts` instead.
 * - **`workers/compliance` registers nothing.** It is a placeholder `fetch`
 *   handler with no Hono and no routes, so it is absent from the table. That is
 *   the opposite of asserting an empty set as covered: an empty set makes "every
 *   route is reachable" true without looking at anything, and `/v1/compliance` is
 *   live in `ROUTE_MAP` while nothing behind it serves a request yet.
 * - **`/v1/automation` is guarded but the Workflow CRUD it names is not
 *   implemented.** The worker registers one route, `/health`, and it is outside
 *   the namespace (see below). The dashboard's "Flujos" page
 *   (`apps/dashboard/src/app/dashboard/communication/workflows/page.tsx:79,95,128`)
 *   calls `GET /v1/automation/workflows`, `POST /v1/automation/workflows` and
 *   `PUT /v1/automation/workflows/{id}/toggle`; none of them exist yet, and
 *   `docs/08-API-Design.md:115-118` documents a PATCH and a DELETE that do not
 *   exist either. Worth knowing when debugging: a 404 from `/v1/automation/…` is
 *   the worker's own `app.notFound`, not the gateway's — it *was* routed, and
 *   then not found. Same status code as bug 1, different file to open.
 *
 * ## Why only `/v1/*` is in scope, and what the exclusions are
 *
 * `routerMiddleware` is mounted at `app.use('/v1/*', …)` in
 * `apps/gateway/src/index.ts`, so a path outside that namespace never reaches
 * `matchRoute` and is not a gateway route by construction. Two workers serve
 * such paths on purpose — `automation`'s `/health` is a liveness probe and
 * `communication`'s `/webhook` is Meta's callback target, which has to be the URL
 * Meta was configured with — and they are listed explicitly below rather than
 * filtered silently. The list is pinned, so adding a path outside `/v1/` is a
 * decision somebody has to make, not one a regex makes for them.
 *
 * ## Why a registration may be a constant
 *
 * `wallet` registers `router.post(WALLET_CALLBACK_PATH, …)`, so capturing source
 * text alone would drop the Google callback from this guard — quietly, on the
 * one path a third party POSTs to and the one whose loss is invisible from both
 * ends (see `wallet-callback-path.contract.test.ts` for that failure mode). So a
 * bare identifier is resolved by reading its `const` declaration out of the same
 * worker, which is the by-name extraction
 * `wallet-callback-path.contract.test.ts` already uses across this boundary.
 * Anything that still cannot be resolved is a precondition failure naming the
 * worker, never a silently dropped route.
 *
 * ## Why the worker's source is read as text rather than imported
 *
 * `apps/gateway` does not depend on any worker package, and that is deliberate:
 * the gateway is the public face, the workers are the services behind it.
 * Importing a worker so a test could compare a list of strings would invert the
 * dependency direction of the whole system to buy a check that reading two files
 * already performs — and would drag drizzle and the Neon client into the
 * gateway's test run. `wallet-callback-path.contract.test.ts` asserts across
 * exactly this same boundary, for exactly this reason; this file follows that
 * precedent rather than inventing a second way across it. So this file is
 * `readFileSync` and a regex, and it is meant to stay that way.
 *
 * ## Why this asserts the binding and not just "a route matched"
 *
 * A match is not reachability. `matchRoute` is longest-prefix, so a route filed
 * under some *other* worker's prefix resolves fine and is then forwarded to a
 * worker that never heard of it — the same 404 from the same gateway, one
 * indirection further out. Asserting that every route resolves to *its own
 * worker's* binding catches both halves: a path no prefix claims, and a path the
 * wrong prefix claims. Hono's `:param` segments are inert here, because
 * `matchRoute` only ever compares the prefix in front of them.
 *
 * ## What this file deliberately does not assert
 *
 * `ROUTE_MAP` is not frozen. The router gaining a prefix for a legitimate new
 * service is normal work, and an assertion about the size or shape of that table
 * would fail on correct changes and train a reader to delete the guard. The one
 * thing said about it is the binding liveness check in the precondition.
 *
 * `matchRoute` compares with a bare `startsWith`, with no segment boundary, so a
 * future `/v1/loyalty-admin` would be claimed by `/v1/loyalty` and forwarded to
 * growth. No such path exists today and this change does not introduce one. It
 * is a latent risk recorded here on purpose: the fix belongs in `router.ts`, and
 * `router.ts` is not this change's to touch.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { matchRoute, ROUTE_MAP } from './router';

/** The workspace `workers/` directory, resolved across the package boundary. */
const WORKERS_DIR = join(__dirname, '..', '..', '..', 'workers');

/**
 * The path prefix `routerMiddleware` is mounted on.
 *
 * `apps/gateway/src/index.ts` mounts it as `app.use('/v1/*', routerMiddleware)`,
 * so this is the whole of the gateway's routing namespace: a worker path outside
 * it is addressed directly at the worker and never reaches `matchRoute`.
 */
const GATEWAY_NAMESPACE = '/v1/';

/**
 * Every worker package this guard covers.
 *
 * The binding each one is asserted against is its own package name, which is the
 * convention `wrangler.jsonc` already follows for service bindings and which the
 * precondition below asserts is still true rather than assuming.
 *
 * A package with no routes is **absent**, not present-and-empty: an empty set
 * makes "every route is reachable" true without anything being checked, and
 * `workers/compliance` is exactly that case.
 */
const WORKERS_UNDER_GUARD = ['identity', 'analytics', 'customer', 'growth', 'wallet', 'communication', 'automation'];

/**
 * Worker routes deliberately outside the gateway's namespace, pinned.
 *
 * Each is reached at the worker's own hostname rather than through the gateway,
 * so `matchRoute` has no opinion about it and neither does this guard's rule.
 * Listing them keeps that a decision rather than a filter: a new path outside
 * `/v1/` fails this list until someone records why it belongs there.
 */
const ROUTES_OUTSIDE_GATEWAY_NAMESPACE = [
  {
    worker: 'automation',
    path: '/health',
    reason: 'liveness probe for the cron-driven host the worker owns',
  },
  {
    worker: 'communication',
    path: '/webhook',
    reason: "Meta's callback target, which must be the URL Meta was configured with",
  },
];

/** The directory a worker's own `src` lives in. */
function workerSrc(worker: string): string {
  return join(WORKERS_DIR, worker, 'src');
}

/**
 * Every non-test module in a worker's `src`.
 *
 * Deliberately all of them rather than only `routes.ts`: `identity` and
 * `analytics` register straight onto the `Hono` instance they export, with no
 * routes module at all, and a worker that moves a registration between its own
 * files must not lose coverage because this file was pointed at the old one. A
 * re-export is not a registration, so reading more files cannot inflate the set.
 */
function workerSourceFiles(worker: string): string[] {
  const src = workerSrc(worker);
  if (!existsSync(src)) {
    return [];
  }
  return readdirSync(src, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map((entry) => join(src, entry.name))
    .sort();
}

/** A worker's `src` read as one document, so a constant can be resolved by name. */
function workerSource(worker: string): string {
  return workerSourceFiles(worker)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

/**
 * The first argument of every `app.<method>(…)` or `router.<method>(…)`
 * registration, **as written**.
 *
 * Both instance names are matched because workers are split between them —
 * `customer`, `growth`, `wallet`, `communication` and `automation` register on a
 * `router` sub-app mounted at `/`, `identity` and `analytics` register on the
 * `app` they export — and which one a worker uses is not a property worth
 * asserting. Only the HTTP verbs are matched, which is what keeps `app.use`,
 * `app.route`, `app.notFound` and `app.onError` out of the set.
 *
 * `[^,)]+?` stops at a comma or a closing paren, which is enough for every
 * registration in these packages because no path here contains either.
 */
function registrationsIn(source: string): string[] {
  return [...source.matchAll(/\b(?:app|router)\.(?:get|post|put|patch|delete)\(\s*([^,)]+?)\s*,/g)].map(
    (match) => match[1],
  );
}

/** The first argument of every registration in a worker, before path resolution. */
function registeredRouteArguments(worker: string): string[] {
  return workerSourceFiles(worker).flatMap((file) => registrationsIn(readFileSync(file, 'utf8')));
}

/**
 * Turn a registration's first argument into the path it serves.
 *
 * A quoted literal resolves to itself. A bare identifier resolves through its own
 * `const` declaration in the same worker, which is what keeps
 * `router.post(WALLET_CALLBACK_PATH, …)` in the guard instead of dropping the
 * Google callback out of it. Anything else returns `undefined`, and the
 * precondition turns that into a named failure instead of a quietly short set.
 */
function resolvePathArgument(argument: string, source: string): string | undefined {
  const literal = /^'([^']*)'$/.exec(argument)?.[1];
  if (literal !== undefined) {
    return literal;
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(argument)) {
    return undefined;
  }
  return new RegExp(`\\bconst\\s+${argument}\\s*=\\s*'([^']*)'`).exec(source)?.[1];
}

/** Every path a worker registers, constants resolved. */
function registeredRoutePaths(worker: string): string[] {
  const source = workerSource(worker);
  return registeredRouteArguments(worker)
    .map((argument) => resolvePathArgument(argument, source))
    .filter((path): path is string => path !== undefined);
}

/** Every worker package that registers at least one route, derived from disk. */
function workerPackagesThatRegisterRoutes(): string[] {
  return readdirSync(WORKERS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((worker) => registeredRouteArguments(worker).length > 0)
    .sort();
}

/** Every unrouted route in a worker, with what `matchRoute` did with it. */
function unreachableRoutes(worker: string): string[] {
  return registeredRoutePaths(worker)
    .filter((path) => path.startsWith(GATEWAY_NAMESPACE))
    .filter((path) => matchRoute(path)?.binding !== worker)
    .map((path) => {
      const routed = matchRoute(path);
      return `${path} → ${routed ? `routed to "${routed.binding}"` : 'no ROUTE_MAP prefix matches'}`;
    });
}

/** The `worker path` keys of the worker routes that sit outside the namespace. */
function routesOutsideGatewayNamespace(): string[] {
  return [
    ...new Set(
      WORKERS_UNDER_GUARD.flatMap((worker) =>
        registeredRoutePaths(worker)
          .filter((path) => !path.startsWith(GATEWAY_NAMESPACE))
          .map((path) => `${worker} ${path}`),
      ),
    ),
  ].sort();
}

describe('every route a worker registers under the gateway namespace is reachable through the gateway', () => {
  it.each(WORKERS_UNDER_GUARD.map((worker) => [worker, worker] as const))(
    'reads the %s worker registrations at all',
    (_name, worker) => {
      // The precondition for the assertion below, and it is a real one rather
      // than a formality. `registeredRoutePaths` drops anything it cannot
      // resolve, so a rename of the Hono instance or a registration moved to a
      // module this extractor cannot see would make it return fewer paths than
      // there are registrations — and an empty set makes "every path is
      // reachable" true. A guard that reports green because it stopped looking is
      // the failure mode every other assertion in this directory exists to
      // avoid, so both counts are asserted, and the first one against zero.
      expect(
        registeredRouteArguments(worker).length,
        `${worker} has no readable router.<method>() registration — the extractor found nothing to check`,
      ).toBeGreaterThan(0);
      expect(
        registeredRoutePaths(worker).length,
        `${worker} has a registration the extractor cannot resolve to a path literal`,
      ).toBe(registeredRouteArguments(worker).length);
    },
  );

  it.each(WORKERS_UNDER_GUARD.map((worker) => [worker, worker] as const))(
    'asserts %s against a binding ROUTE_MAP actually forwards to',
    (_name, worker) => {
      // The guard compares `matchRoute(path)?.binding` to the package name, which
      // works only while package name and binding name are the same string. That
      // is a convention, not a type, so it is asserted here: a package or a
      // binding renamed apart from the other stops this guard from silently
      // asserting against a binding nothing forwards to.
      //
      // Note what this is *not*: an assertion about how many entries `ROUTE_MAP`
      // has. Growing that table is normal work and must not break this file.
      expect(
        ROUTE_MAP.some((route) => route.binding === worker),
        `no ROUTE_MAP entry forwards to the "${worker}" binding this guard extracts`,
      ).toBe(true);
    },
  );

  it('guards every worker package that registers a route', () => {
    // Completeness, which is the one way this guard could shrink its own
    // coverage without failing. A ninth worker lands, registers a route, and is
    // absent from the table above: everything still passes and the new routes
    // are unchecked.
    //
    // So the set is re-derived from the filesystem on every run, using the same
    // extractor, and the two have to agree. Adding a worker that registers
    // routes is expected to fail here once, naming itself, before it is guarded.
    expect(workerPackagesThatRegisterRoutes()).toEqual([...WORKERS_UNDER_GUARD].sort());
  });

  it.each(WORKERS_UNDER_GUARD.map((worker) => [worker, worker] as const))(
    'routes every %s path to the %s service binding',
    (_name, worker) => {
      // The rule, stated once: a route the worker serves is a route the gateway
      // can hand to it, and to *it* rather than to whoever matched first.
      //
      // `POST /v1/checkins` and `POST /v1/passes/resolve` failed here before
      // being moved under `/v1/loyalty`, and the message names the path and the
      // reason, because "unreachable" on its own sends the next reader looking at
      // the worker rather than at `ROUTE_MAP` — which is the wrong file, and the
      // one where the last two of these bugs were fixed.
      expect(unreachableRoutes(worker)).toEqual([]);
    },
  );

  it('lists every worker route that sits outside the gateway namespace', () => {
    // The scope of the rule above, stated rather than assumed. `routerMiddleware`
    // is mounted on `/v1/*`, so these paths are reached at the worker's own
    // hostname and `matchRoute` has no opinion about them — silently skipping
    // them would look identical to forgetting them, so the set is pinned. A new
    // non-`/v1/` path fails here until someone records where it is addressed
    // from, which is the moment the question is worth asking.
    expect(routesOutsideGatewayNamespace()).toEqual(
      ROUTES_OUTSIDE_GATEWAY_NAMESPACE.map((route) => `${route.worker} ${route.path}`).sort(),
    );
  });

  it('serves the two POS routes from under the prefix the gateway already forwards', () => {
    // The decision, as opposed to the consequence.
    //
    // The alternative to moving these under `/v1/loyalty` was adding
    // `/v1/checkins` and `/v1/passes/resolve` to `ROUTE_MAP`, and it was
    // rejected: the router 404s on an unmatched prefix rather than falling
    // through, which is exactly what made these two routes unreachable and has
    // broken the same way twice already. Growing the table is a fix that leaves
    // the fragility in place and adds two more prefixes for it to hide behind.
    //
    // So this asserts the routes sit where the reuse decision put them. A
    // *different* path under `/v1/loyalty` would still be reachable, and that is
    // deliberately not a failure — only leaving the forwarded prefix is. It also
    // survives generalisation deliberately: the rule above is per worker and
    // names no prefix, so without this the pin would be the only thing holding
    // the decision in place.
    for (const path of ['/v1/loyalty/checkins', '/v1/loyalty/passes/resolve']) {
      expect(registeredRoutePaths('growth'), `${path} is not registered by the growth worker`).toContain(path);
      expect(matchRoute(path)?.binding, `${path} does not reach the growth worker`).toBe('growth');
    }
  });
});