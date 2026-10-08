/// <reference types="node" />
// @vitest-environment node

/**
 * Every path the gateway treats as public is unauthenticated by the worker that
 * serves it too.
 *
 * ## The sixth bug of this class, and why the existing guard could not see it
 *
 * Five defects in this repository have been the same shape: a route registered
 * correctly, covered by passing tests, and **unreachable because a layer in front
 * of it refuses**.
 *
 *   1. `/v1/support` was answered by the gateway worker and had no `ROUTE_MAP`
 *      entry, so `routerMiddleware` 404'd it instead of falling through.
 *   2. The `wallet` service binding was declared in `wrangler.jsonc` with no
 *      prefix in `ROUTE_MAP`.
 *   3. `POST /v1/checkins` was complete, tested, merged and deployed under a
 *      prefix nothing forwarded.
 *   4. `matchRoute` matched on a bare `startsWith`, so `/v1/loyalty-admin` would
 *      have been claimed by `/v1/loyalty`.
 *   5. `workers/growth/src/index.ts` registered `app.use('*', …)` calling
 *      `extractAuthHeaders` unconditionally, so the payment rail's webhook
 *      receiver answered 403 on every delivery — a third party sends no `X-*`
 *      headers, and there is no credential for it to send.
 *
 * `wrangler-route-reachability.contract.test.ts` covers the *gateway's* half of
 * that chain: does a `ROUTE_MAP` prefix forward this worker's path, to that
 * worker. It is a good guard and it was green through all five. **Nothing guarded
 * the worker's half**, which is why bug 5 was reachable at all: a path can be
 * routed to the right worker by a prefix, exempted from auth at the gateway, and
 * then refused by the worker it was routed to.
 *
 * The two halves are independent, and either one alone is a dead route.
 *
 * ## The rule, stated once
 *
 * For every path the gateway declares public — each entry of `EXACT_PUBLIC_PATHS`
 * and `WEBHOOK_PREFIX` — the worker that `matchRoute` sends it to must exempt it
 * from that worker's own authentication middleware.
 *
 * Two things are deliberately **not** claimed here:
 *
 *   - **That the path is registered.** Whether a registration is reachable is
 *     `wrangler-route-reachability.contract.test.ts`'s job; duplicating it here
 *     would give two files to update for one route and two messages to read for
 *     one defect.
 *   - **That the worker authenticates anything.** A worker with no auth middleware
 *     makes the exemption a no-op, which satisfies the rule truthfully. "No
 *     exemption mechanism exists" and "a mechanism exists and does not exempt this"
 *     are different states, and only the second is this bug — so they are kept
 *     apart rather than collapsed, and the first is reported as its own named case
 *     below rather than silently ignored.
 *
 * ## Why an inapplicable path is a pinned exception, not a skip
 *
 * Two of the gateway's public declarations have no exemption this rule can ask
 * for, and both are listed in `PUBLIC_PATHS_WITHOUT_AN_EXEMPTION` with the
 * reason. That is the shape `wrangler-route-reachability.contract.test.ts` uses
 * for `ROUTES_OUTSIDE_GATEWAY_NAMESPACE`, and for the same reason: **a silent
 * filter looks identical to forgetting**. A new public declaration that lands in
 * this category has to be added to the list by somebody who writes down why, which
 * is the moment the question "which package is meant to exempt this?" is worth
 * asking.
 *
 * The list is asserted to be exactly the set the rule cannot apply to, in both
 * directions, and asserted to contain nothing stale. An exception that has stopped
 * being true is worse than no exception: it tells the reader a path needs no
 * exemption when the rule would otherwise apply to it. If a worker starts
 * registering one of these paths, the rule applies from that moment and the entry
 * must be deleted.
 *
 * ## Why the worker's source is read as text rather than imported
 *
 * `apps/gateway` deliberately depends on no worker package: the gateway is the
 * public face, the workers are the services behind it. Importing growth so a test
 * could compare a set of strings would invert the dependency direction of the whole
 * system to buy a check that reading two files already performs — and it would drag
 * drizzle and the Neon client into the gateway's test run. Both
 * `wrangler-route-reachability.contract.test.ts` and `api-openapi.contract.test.ts`
 * assert across exactly this boundary for exactly this reason, so this file follows
 * that precedent rather than inventing a second way across it.
 *
 * The alternative — exporting `PUBLIC_PATHS` from each worker and importing it — is
 * rejected for the same reason. `workers/wallet` already keeps its set a private
 * `const`, and `workers/growth` copied that arrangement; making either of them
 * public *for a cross-package consumer* is a coupling nobody asked for, traded for
 * a check two file reads perform.
 *
 * ## What `readFileSync` and a regex costs, stated rather than glossed
 *
 * A regex cannot understand TypeScript, so this extraction understands exactly one
 * declaration shape — `PUBLIC_PATHS … = new Set([…])` — and nothing else. A worker
 * that computed its public set some other way would be invisible here, which would
 * make this file report green while checking nothing. Two things close that: the
 * extraction is deliberately narrow rather than clever, and the round-trip
 * assertions in the last describe block compare the string the worker *registers*
 * against the string the gateway *exempts*, so the two halves have to agree on a
 * real route and not merely on a matching pair of literals.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { matchRoute, ROUTE_MAP } from './router';

import { EXACT_PUBLIC_PATHS, WEBHOOK_PREFIX } from './index';

const WORKERS_DIR = join(__dirname, '..', '..', '..', 'workers');

/**
 * Public declarations the rule below cannot be applied to, with the reason.
 *
 * See the file header for why this is a pinned list and not a filter. Nothing
 * here is exempt by a worker, so nothing here can be checked against one.
 */
const PUBLIC_PATHS_WITHOUT_AN_EXEMPTION: readonly { path: string; reason: string }[] = [
  {
    path: '/v1/support',
    reason:
      'answered by apps/gateway itself — ROUTE_MAP binds it to `gateway`, and the gateway has no auth middleware in front of its own routes, so there is no worker package whose exemption set could apply',
  },
  {
    path: '/v1/communication/webhook',
    reason:
      'forwarded to the communication worker, which authenticates every path through an unconditional app.use("*") and declares no PUBLIC_PATHS set at all. Nothing is registered under this prefix — the worker serves Meta at /webhook, outside the gateway namespace — so the prefix currently 404s at the worker rather than 403ing. That is a latent instance of exactly this bug class, and it is recorded rather than fixed: workers/communication/src/index.ts is outside this change. The fix is the same shape as the growth exemption, and it must land in the same change that registers a route there',
  },
];

/** Every non-test module in a worker's `src`. */
function workerSourceFiles(worker: string): string[] {
  const src = join(WORKERS_DIR, worker, 'src');
  if (!existsSync(src)) return [];
  return readdirSync(src, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map((entry) => join(src, entry.name))
    .sort();
}

/**
 * Strip comments, because a regex over source that still contains prose matches
 * prose.
 *
 * `api-openapi.contract.test.ts` has the same helper for the same reason: a
 * docblock in this repository quotes the very declarations its guards read, so a
 * comment-aware read is the difference between finding a declaration and finding
 * the sentence that describes it. Both forms are handled — line comments and
 * block comments — and the docblocks here are heavier than the code they document,
 * which is exactly why the first version of this extractor did find the wrong
 * thing.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** A worker's whole `src` as one comment-free document. */
function workerSource(worker: string): string {
  return workerSourceFiles(worker)
    .map((file) => withoutComments(readFileSync(file, 'utf8')))
    .join('\n');
}

/** Resolve a literal, or a bare identifier through its own `const` declaration. */
function resolvePathArgument(argument: string, source: string): string | undefined {
  const literal = /^'([^']*)'$/.exec(argument)?.[1];
  if (literal !== undefined) return literal;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(argument)) return undefined;
  return new RegExp(`\\bconst\\s+${argument}\\s*=\\s*'([^']*)'`).exec(source)?.[1];
}

/**
 * Every path a worker exempts from its auth middleware, or `undefined` when the
 * worker declares no exemption set at all.
 *
 * `undefined` and `[]` are deliberately distinct. `[]` means "this worker has an
 * exemption mechanism and exempts nothing", which fails the rule for every public
 * path it serves. `undefined` means "this worker declares no such mechanism", which
 * is a true statement about a worker that has no exemption to offer and is reported
 * separately rather than failed.
 */
function workerExemptedPaths(worker: string): string[] | undefined {
  const source = workerSource(worker);
  const declaration = /\bPUBLIC_PATHS\b[^=]*=\s*new Set\(\s*\[([^\]]*)\]/m.exec(source);
  if (!declaration) return undefined;

  return declaration[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => resolvePathArgument(entry, source))
    .filter((path): path is string => path !== undefined);
}

/** The first argument of every `app.<method>()` / `router.<method>()` registration. */
function registeredRouteArguments(worker: string): string[] {
  return workerSourceFiles(worker)
    .flatMap((file) => [
      ...withoutComments(readFileSync(file, 'utf8')).matchAll(
        /\b(?:app|router)\.(?:get|post|put|patch|delete)\(\s*([^,)]+?)\s*,/g,
      ),
    ])
    .map((match) => match[1]);
}

/** Every path a worker registers, constants resolved. */
function registeredRoutePaths(worker: string): string[] {
  const source = workerSource(worker);
  return registeredRouteArguments(worker)
    .map((argument) => resolvePathArgument(argument, source))
    .filter((path): path is string => path !== undefined);
}

/** Every worker package, derived from disk rather than pinned. */
function workerPackages(): string[] {
  return readdirSync(WORKERS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Every path the gateway declares public.
 *
 * `EXACT_PUBLIC_PATHS` is finite, so it is enumerated. `WEBHOOK_PREFIX` covers an
 * unbounded subtree, so the **prefix itself** is what is checked: a prefix is what
 * an exemption predicate compares against, so exempting the prefix exempts
 * everything under it. Checking a representative child instead would assert less
 * than the gateway's own `startsWith` predicate does.
 */
function gatewayPublicPaths(): string[] {
  return [...EXACT_PUBLIC_PATHS, WEBHOOK_PREFIX];
}

/** The worker `matchRoute` sends a path to, if any. */
function servingWorker(path: string): string | undefined {
  return matchRoute(path)?.binding;
}

/**
 * Public paths an authenticating worker will refuse, described so the message
 * names both halves of the failure.
 *
 * A worker absent from `ROUTE_MAP`, bound to `gateway` itself, or declaring no
 * exemption set is *not* in this set: those are the `PUBLIC_PATHS_WITHOUT_AN_
 * EXEMPTION` cases, asserted separately and by name.
 */
function publicPathsAnAuthenticatingWorkerWillRefuse(): string[] {
  return gatewayPublicPaths()
    .map((path) => ({ path, worker: servingWorker(path) }))
    .filter(({ worker }) => worker !== undefined && worker !== 'gateway')
    .filter(({ path, worker }) => {
      const exempted = workerExemptedPaths(worker as string);
      return exempted !== undefined && !exempted.includes(path);
    })
    .map(
      ({ path, worker }) =>
        `${path} is public at the gateway but the ${worker} worker does not exempt it, so every delivery answers 403 UNAUTHORIZED`,
    );
}

/** Public paths the rule cannot be applied to, as paths. */
function publicPathsWithoutAnExemption(): string[] {
  return gatewayPublicPaths()
    .filter((path) => {
      const worker = servingWorker(path);
      if (worker === undefined || worker === 'gateway') return true;
      return workerExemptedPaths(worker) === undefined;
    })
    .sort();
}

describe('every gateway-public path is exempt from the worker that serves it', () => {
  it('reads both sides of the comparison', () => {
    // The precondition, and a real one rather than a formality. Every assertion
    // in this file compares two extracted sets, so an extractor that stops finding
    // things makes each of them vacuously true. A guard that reports green because
    // it stopped reading is worse than no guard, because it looks like coverage —
    // which is the failure mode `migration-sql.test.ts` guards against explicitly
    // for the same reason.
    expect(gatewayPublicPaths().length).toBeGreaterThan(0);
    expect(EXACT_PUBLIC_PATHS.length).toBeGreaterThan(0);
    expect(workerPackages().length).toBeGreaterThan(0);
    expect(
      EXACT_PUBLIC_PATHS.length,
      'EXACT_PUBLIC_PATHS yielded nothing, so the set-equality assertion below would be empty === empty',
    ).toBeGreaterThan(0);
  });

  it('exempts every gateway-public path in the worker that serves it', () => {
    // The rule. The message names the path *and* the worker that will refuse it,
    // because "unreachable" on its own sends the next reader to open the route —
    // which is the file that is correct — instead of the middleware in front of it,
    // which is where this class of bug was fixed all five previous times.
    expect(publicPathsAnAuthenticatingWorkerWillRefuse()).toEqual([]);
  });

  it('pins every public declaration it cannot check, so a new one is a decision', () => {
    // Asserted in the direction that matters: the rule above only inspects paths
    // that reach an exempting worker, so a public declaration that reaches none is
    // invisible to it — and an invisible exemption is how this file would grow a
    // hole while still reporting green. A fourth entry in `EXACT_PUBLIC_PATHS` that
    // no worker serves fails here until somebody records which package was meant to
    // exempt it.
    expect(publicPathsWithoutAnExemption()).toEqual(
      PUBLIC_PATHS_WITHOUT_AN_EXEMPTION.map((entry) => entry.path).sort(),
    );
  });

  it('keeps no stale entry in that list', () => {
    // The other direction. An exception that has stopped being true tells the
    // reader a path needs no exemption when the rule would now apply to it — and
    // once a worker registers such a path, a 403 is one middleware edit away.
    // If this fails, delete the entry: the rule above will cover the path from
    // there, which is the entire point of keeping the list pinned.
    const stale = PUBLIC_PATHS_WITHOUT_AN_EXEMPTION.filter(({ path }) =>
      workerPackages().some((worker) => registeredRoutePaths(worker).includes(path)),
    );

    expect(stale.map(({ path }) => `${path} is registered by a worker now, so the exemption applies`)).toEqual(
      [],
    );
  });

  it('gives every pinned path a written reason', () => {
    // An exception with an empty reason is a hole with a comment that says nothing
    // — which is what the `KNOWN_UNDECLARED` entry in
    // `wrangler-config.contract.test.ts` was. The exemption *was* the bug, and
    // documenting it is not a defence against that.
    for (const entry of PUBLIC_PATHS_WITHOUT_AN_EXEMPTION) {
      expect(entry.reason.trim().length, `${entry.path} has no recorded reason`).toBeGreaterThan(40);
    }
  });

  it('finds the exemption set in the worker that has one, so extraction works', () => {
    // The precondition for the rule being about anything at all, and asserted per
    // worker rather than once. If the extractor stopped recognising the
    // `new Set([...])` shape, every worker would read as having no exemption
    // mechanism, every public path would fall into the pinned list, and the rule
    // above would pass on an empty comparison.
    const growth = workerExemptedPaths('growth');
    expect(growth, 'growth declares no PUBLIC_PATHS set the extractor can read').toEqual([
      '/v1/loyalty/webhooks/payments',
    ]);

    const wallet = workerExemptedPaths('wallet');
    expect(wallet, 'wallet declares no PUBLIC_PATHS set the extractor can read').toEqual([
      '/v1/wallet/google/callback',
    ]);
  });
});

describe('the two copies of the payment receiver path', () => {
  // `apps/gateway` must not import the worker that serves the path — see the file
  // header — so the string is written twice. That is the arrangement the wallet
  // callback uses too, and the reason it has its own contract test: a one-sided
  // rename either exempts a path the worker does not have, or 403s one it does.

  it('agree between the gateway and the growth worker', () => {
    // The gateway's public-path set and the worker's exemption set are two halves
    // of one fact, and this asserts the string in both is the same string. Without
    // it a rename on either side is green here and broken in production, with a
    // 403 whose message is about missing headers — which reads as a gateway
    // misconfiguration and sends the reader to the wrong file entirely.
    const gatewayPath = /\bconst\s+PAYMENT_WEBHOOK_PATH\s*=\s*'([^']+)'/.exec(
      withoutComments(readFileSync(join(__dirname, 'index.ts'), 'utf8')),
    )?.[1];

    const workerPath = /\bconst\s+PAYMENT_WEBHOOK_PATH\s*=\s*'([^']+)'/.exec(workerSource('growth'))?.[1];

    expect(gatewayPath, 'the gateway no longer declares PAYMENT_WEBHOOK_PATH').toBeDefined();
    expect(workerPath, 'the growth worker no longer declares PAYMENT_WEBHOOK_PATH').toBeDefined();
    expect(
      gatewayPath,
      'the gateway and the growth worker disagree about the payment webhook path',
    ).toBe(workerPath);
    expect(gatewayPath).toBe(EXACT_PUBLIC_PATHS.find((path) => path === '/v1/loyalty/webhooks/payments'));
  });

  it('is the path the growth worker actually registers', () => {
    // The two copies agreeing on a string nothing serves would satisfy the test
    // above while delivering nothing. This is the registration itself, read the
    // same way `wrangler-route-reachability.contract.test.ts` reads one — and
    // `router.post(PAYMENT_WEBHOOK_PATH, …)` is a constant, not a literal, so it is
    // the by-name extraction that keeps it in the set.
    expect(registeredRoutePaths('growth')).toContain('/v1/loyalty/webhooks/payments');
  });

  it('is routed to growth by a prefix that already exists, not a new ROUTE_MAP entry', () => {
    // `/v1/loyalty` already forwards to growth. Asserted so the receiver cannot be
    // made reachable by growing `ROUTE_MAP` instead — the fix this repository has
    // already tried twice and rejected, because the router 404s an unmatched
    // prefix rather than falling through, which is what made those two bugs.
    expect(matchRoute('/v1/loyalty/webhooks/payments')?.binding).toBe('growth');
    expect(
      ROUTE_MAP.map((route) => route.prefix).filter((prefix) => '/v1/loyalty/webhooks'.startsWith(prefix)),
      'a prefix was added for this route, so reachability now depends on the table growing',
    ).toEqual(['/v1/loyalty']);
  });
});
