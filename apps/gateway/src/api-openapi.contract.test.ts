/// <reference types="node" />
// @vitest-environment node

/**
 * `api/docs/openapi.yaml` describes the payment terminal integration, and it is
 * hand-written, so it will drift.
 *
 * ## The bug this file exists to prevent
 *
 * A hand-written API document is the only artefact in this repository that
 * describes the system without being derived from it. Every other contract in
 * this codebase holds because a test re-derives the truth from source and
 * compares; this one holds only as long as somebody remembers to update it, and
 * the failure mode is silent in both directions:
 *
 *   - **The document drifts outward.** A status code changes from 404 to 409, an
 *     error code is renamed, a route moves. The document keeps describing the
 *     old contract, an integrator builds against it, and the mismatch is
 *     discovered in production rather than in review.
 *   - **The document drifts inward, and this one is worse.** A new counter route
 *     is added and simply is not written down. The document now looks complete,
 *     the integrator reads three endpoints and concludes the surface is three
 *     endpoints, and an endpoint exists that no client knows about.
 *
 * The second direction is why this asserts set equality rather than containment.
 * "Every documented path is registered" is satisfied by a document that forgot
 * half the API.
 *
 * ## What is compared, and what is deliberately not
 *
 * Two things, because those are the two that can be checked without a running
 * system and without inventing one:
 *
 *   1. **The documented path set equals the counter surface actually
 *      registered in the workers.** Derived, not pinned — see below.
 *   2. **Every error `code` the document writes is one the workers emit**, and
 *      every code the counter surface emits is written down.
 *
 * Status codes and request/response *shapes* are **not** asserted. Those would
 * need a parser and a schema library, or a hand-rolled one that would itself be
 * a source of false confidence. This file therefore proves the document and the
 * source agree about *which routes exist and which codes they emit*; it does not
 * prove anything about a body. A green run here is necessary and not sufficient,
 * and saying so is part of the job — a guard that is quietly over-trusted is the
 * failure mode every other contract test in this repository is written against.
 *
 * ## Why the counter surface is derived rather than listed
 *
 * The set of endpoints this document covers is **not** written as a list here,
 * because a list would make the second drift direction undetectable: adding a
 * route and forgetting the list would fail nothing.
 *
 * Instead the set is re-derived on every run from the two authorization
 * primitives that define the surface, which is the same trick
 * `wrangler-route-reachability.contract.test.ts` uses with `WORKERS_UNDER_GUARD`:
 *
 *   - a route that calls **`requireCounterSubject(`** is a route only a payment
 *     terminal may call. Those are the routes this integration exists to use.
 *   - the route that calls **`counterSubject(`** is the issuer — the one place a
 *     `pos:` subject is ever minted, and therefore the one route a client needs
 *     in order to obtain the token the others require.
 *
 * Together those are the integration's whole authorization surface, and a fourth
 * route joining it fails this file whether or not anybody remembers the
 * document existed.
 *
 * This is why a prose mention of either helper does not count. `requireCounterSubject`
 * is named in a comment inside the identity worker and again inside
 * `packages/db`, and a substring search would fold both into the surface. The
 * pattern is therefore anchored to the start of a statement, so a comment
 * cannot contribute a route. The cost is that it reads formatting, which this
 * repository already accepts elsewhere for the same reason — see the note on
 * `computeEarnedPoints` in `workers/growth/src/routes.ts`, whose *spelling* is
 * load-bearing for `loyalty-points.contract.test.ts`.
 *
 * ## Why `requireCounterSubject`'s own code is read out of helpers.ts
 *
 * Both loyalty handlers refuse through `gate.code`, a value the handler does not
 * name — the guard computes it. Reading only the handler bodies would therefore
 * omit `COUNTER_SUBJECT_REQUIRED`, and the document names it, and the guard
 * would report a drift on a spec that is right.
 *
 * So the guard is read the same way: its body is sliced out of `helpers.ts` and
 * its `code:` resolved, which keeps the value in one place rather than
 * hard-coding it here. A handler's `gate.code` is not silently ignored — an
 * unresolvable `code:` that is *not* of the guard's shape is a named
 * precondition failure, so the extractor cannot quietly stop seeing codes.
 *
 * ## Why the worker source is read as text and not imported
 *
 * The same reason `wrangler-route-reachability.contract.test.ts` gives, and the
 * same precedent: `apps/gateway` deliberately depends on no worker package,
 * because the gateway is the public face and the workers are the services behind
 * it. Importing a worker so a test could compare three strings would invert the
 * dependency direction of the system to buy a check that reading four files
 * already performs — and would drag drizzle and the Neon client into the
 * gateway's test run. So this is `readFileSync` and a regex, and it is meant to
 * stay that way.
 *
 * ## Why this file lives in the gateway and not next to the document
 *
 * `api/` is not a workspace package — `pnpm-workspace.yaml` globs `apps/*`,
 * `packages/*`, `services/*`, `tooling/*` and `workers/*` — and CI runs
 * `pnpm -r test` plus `npx vitest run --dir scripts`. A test placed in `api/docs/`
 * would therefore be collected by **nothing**: not by a package run and not by
 * the scripts run. It would read as coverage in review and assert nothing, which
 * is worse than having no test at all.
 *
 * So the document lives at `api/docs/openapi.yaml` where the integrator will
 * look for it, and the guard lives in the package whose `vitest run` already
 * covers this exact boundary. That is `apps/gateway`, for a reason beyond
 * convenience: the gateway owns the `/v1/*` namespace all three paths sit in,
 * it owns the public-path exemption that makes the token route callable without
 * a token, and it already hosts the cross-boundary source-reading contract test
 * this one is modelled on.
 *
 * Editing `pnpm-workspace.yaml` to make `api/` a package would have been the
 * other way to wire it, and it would have been a much larger change than adding
 * one file: a package manifest, a `vitest` script and a `typecheck` entry for a
 * directory that contains a YAML file and a Markdown file.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** The workspace root, resolved across the package boundary. */
const REPO_ROOT = join(__dirname, '..', '..', '..');

/** The hand-written contract under guard. */
const SPEC_PATH = join(REPO_ROOT, 'api', 'docs', 'openapi.yaml');

/** Registers routes on the instance it exports, and mints the `pos:` subject. */
const IDENTITY_INDEX = join(REPO_ROOT, 'workers', 'identity', 'src', 'index.ts');

/** Registers the loyalty routes on a `router` sub-app. */
const GROWTH_ROUTES = join(REPO_ROOT, 'workers', 'growth', 'src', 'routes.ts');

/** Exports `requireCounterSubject` and the code it refuses with. */
const GROWTH_HELPERS = join(REPO_ROOT, 'workers', 'growth', 'src', 'helpers.ts');

/**
 * The guard that opens the loyalty routes, called at the top of a handler to
 * make it counter-only.
 */
const COUNTER_GUARD = 'requireCounterSubject';

/**
 * The issuer helper, called exactly where a route decides what a counter's token
 * subject is.
 */
const COUNTER_SUBJECT_BUILDER = 'counterSubject';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Drop comments, so a prose mention of a helper or a `code:` is not read as
 * code.
 *
 * **Order matters, and it is load-bearing.** Line comments go first. These
 * sources discuss the gateway's namespace in prose, and a line reading
 * `// ... the /v1/ namespace ...` can put a literal slash-star in the middle of
 * a comment. Stripping block comments first treats that as the start of a
 * comment and eats everything up to the next closing marker — which swallowed
 * the `counterSubject(terminal.id)` call in the identity worker and left the
 * issuer route silently absent from the surface. A guard that loses a route and
 * reports green is the failure this file exists to prevent, so the ordering is
 * stated here rather than left to whoever reorders these two lines.
 *
 * Stripping `//` at the first occurrence on a line is safe only because no
 * string literal in `workers/growth/src/{helpers,routes}.ts` or
 * `workers/identity/src/index.ts` contains `//`. That is a checked property of
 * those three files, not a general truth, and worth remembering before pointing
 * this at another one.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

/** One `app.<method>('/path', …)` or `router.<method>('/path', …)` site. */
interface Registration {
  /** The path as written in the first argument. */
  argument: string;
  /** The source from this registration to the next one, or to end of file. */
  body: string;
}

/**
 * Every route registration in a worker, with the text that follows it.
 *
 * Both instance names are matched because the workers are split between them:
 * `identity` registers on the `app` it exports while `growth` registers on a
 * `router` sub-app, and which one a worker uses is not a property worth
 * asserting. Only HTTP verbs are matched, which is what keeps `app.use`,
 * `app.route`, `app.notFound` and `app.onError` out of the set.
 *
 * The body is what makes the counter surface derivable: it is the only way to
 * ask "does this handler call the counter guard" without importing the worker.
 */
function registrationsIn(path: string): Registration[] {
  const source = read(path);
  const matches = [
    ...source.matchAll(/\b(?:app|router)\.(?:get|post|put|patch|delete)\(\s*([^,)]+?)\s*,/g),
  ];
  return matches.map((match, index) => ({
    argument: match[1],
    body: source.slice(match.index, matches[index + 1]?.index ?? source.length),
  }));
}

/**
 * Resolve a registration's first argument to the path it serves.
 *
 * A quoted literal resolves to itself. A bare identifier resolves through its
 * own `const` declaration in the same worker, so a route that later moves behind
 * a named constant is not silently dropped from the surface — the same
 * by-name extraction `wallet-callback-path.contract.test.ts` performs across this
 * boundary. Anything else returns `undefined`, and the precondition below turns
 * that into a named failure rather than a quietly short surface.
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
function registeredRoutesIn(path: string): string[] {
  const source = read(path);
  return registrationsIn(path)
    .map((registration) => resolvePathArgument(registration.argument, source))
    .filter((resolved): resolved is string => resolved !== undefined);
}

/**
 * Every `const NAME = 'value'` in a file, whether exported or not.
 *
 * `COUNTER_SUBJECT_REQUIRED` is exported and `TIER_ORDERING_CONFLICT` is not, so
 * both spellings are captured: this table exists to resolve an identifier that
 * appeared in a `code:` position, and it must not depend on the author having
 * remembered the `export` keyword.
 */
function stringConstsIn(source: string): Map<string, string> {
  const table = new Map<string, string>();
  for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*'([^']*)'/g)) {
    table.set(match[1], match[2]);
  }
  return table;
}

// ---------------------------------------------------------------------------
// The counter surface
// ---------------------------------------------------------------------------

/**
 * Does a handler body actually *call* the helper, as opposed to mentioning it?
 *
 * Anchored to the start of a statement, optionally through the
 * `const gate = ` that captures the guard's result. This is the whole reason a
 * route list could be derived rather than pinned: `requireCounterSubject` is
 * named in a comment inside the identity worker and in `packages/db`, and a
 * substring search would have counted those as routes.
 */
function callsHelper(body: string, helper: string): boolean {
  return new RegExp(`^\\s*(?:const\\s+[A-Za-z_$][A-Za-z0-9_$]*\\s*=\\s*)?${helper}\\(`, 'm').test(
    withoutComments(body),
  );
}

/** Every path registered in a file whose handler calls `helper`. */
function routesCalling(path: string, helper: string): string[] {
  const source = read(path);
  return registrationsIn(path)
    .filter((registration) => callsHelper(registration.body, helper))
    .map((registration) => resolvePathArgument(registration.argument, source))
    .filter((resolved): resolved is string => resolved !== undefined);
}

/**
 * The path of the route that mints a counter subject.
 *
 * Only one route can call the issuer helper, and this asserts the count rather
 * than taking the first: a second issuer would mean two places that know how to
 * spell `pos:<terminalId>`, which is exactly the disagreement
 * `counterSubject` was extracted to prevent.
 */
function counterIssuerRoutes(): string[] {
  return routesCalling(IDENTITY_INDEX, COUNTER_SUBJECT_BUILDER);
}

/** The routes that only a payment terminal may call. */
function counterGuardedRoutes(): string[] {
  return routesCalling(GROWTH_ROUTES, COUNTER_GUARD);
}

/** The whole integration surface: the guarded routes plus the one that issues the token. */
function integrationSurface(): string[] {
  return [...counterGuardedRoutes(), ...counterIssuerRoutes()].sort();
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Every error `code:` in a block of source, resolved to its literal string.
 *
 * Three shapes are possible at a `code:` site and each is handled explicitly:
 *
 *   - `'LITERAL'`                       → the string.
 *   - `CONSTANT`                        → resolved through the file's const table.
 *   - `gate.code` (a member expression) → **not** resolvable from the handler,
 *     because the guard computed it. Recognised as the guard's shape and set
 *     aside; its value is read out of the guard itself in
 *     `emittedCounterCodes`, so nothing is lost and no string is duplicated
 *     here.
 *
 * Anything else lands in `unreadable` and is a named failure. A silently dropped
 * `code:` is the one failure this whole file cannot tolerate: the guard would
 * narrow its own coverage and report green.
 */
function errorCodesIn(
  body: string,
  constTable: Map<string, string>,
): { resolved: string[]; guardShaped: string[]; unreadable: string[] } {
  const resolved: string[] = [];
  const guardShaped: string[] = [];
  const unreadable: string[] = [];

  for (const match of withoutComments(body).matchAll(/\bcode:\s*([^,}\n]+?)\s*[,}]/g)) {
    const expression = match[1].trim();

    const literal = /^'([^']*)'$/.exec(expression)?.[1];
    if (literal !== undefined) {
      resolved.push(literal);
      continue;
    }

    const fromConst = constTable.get(expression);
    if (fromConst !== undefined) {
      resolved.push(fromConst);
      continue;
    }

    // `gate.code` and `effective.code` alike: a guard's own result, computed
    // where the guard is defined rather than where it is called.
    if (/^[A-Za-z_$][A-Za-z0-9_$]*\.code$/.test(expression)) {
      guardShaped.push(expression);
      continue;
    }

    unreadable.push(expression);
  }

  return { resolved, guardShaped, unreadable };
}

/**
 * The body of a function, found by counting braces from its declaration.
 *
 * Brace counting rather than "to the end of the file" because slicing to EOF
 * swallows whatever follows the function, and what follows `requireCounterSubject`
 * is a type declaration containing `code: string; message: string` — which is
 * then read as an unresolvable `code:` site and fails the precondition below. The
 * guard would have reported a fault in a spec that is perfectly right.
 *
 * Safe here for the same reason comment stripping is: no string literal in this
 * file contains a brace, so the count cannot be thrown off by one inside a
 * message.
 */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `${declaration} is not present in this source any more`).toBeGreaterThan(-1);

  const withoutDocblock = withoutComments(source.slice(start));
  let depth = 0;
  for (let index = 0; index < withoutDocblock.length; index += 1) {
    if (withoutDocblock[index] === '{') {
      depth += 1;
    } else if (withoutDocblock[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return withoutDocblock.slice(0, index + 1);
      }
    }
  }
  // Falling out means unbalanced braces, which is a malformed source rather than
  // an empty function. Named, never returned as a short body.
  throw new Error(`no closing brace for ${declaration} — the source is malformed`);
}

/** The source of `requireCounterSubject` itself, so its code is read not assumed. */
function counterGuardBody(): string {
  return functionBody(read(GROWTH_HELPERS), `export function ${COUNTER_GUARD}(`);
}

/**
 * Every error code the counter surface can emit, from source.
 *
 * The guard's own code is included because both loyalty handlers refuse through
 * `gate.code`, so it is unreachable from a handler body and would otherwise look
 * like a document that documents a code nobody emits.
 */
function emittedCounterCodes(): string[] {
  const helpersTable = stringConstsIn(read(GROWTH_HELPERS));
  const guard = errorCodesIn(counterGuardBody(), helpersTable);

  expect(
    guard.unreadable,
    `${COUNTER_GUARD} no longer refuses with a code this file can read`,
  ).toEqual([]);

  const emitted = new Set(guard.resolved);

  for (const worker of [
    { path: IDENTITY_INDEX, routes: counterIssuerRoutes() },
    { path: GROWTH_ROUTES, routes: counterGuardedRoutes() },
  ]) {
    const source = read(worker.path);
    const table = stringConstsIn(source);
    const counterRoutes = new Set(worker.routes);

    for (const registration of registrationsIn(worker.path)) {
      const resolvedPath = resolvePathArgument(registration.argument, source);
      if (resolvedPath === undefined || !counterRoutes.has(resolvedPath)) {
        continue;
      }

      const found = errorCodesIn(registration.body, table);

      // A `code:` the extractor cannot read is a named failure. It is the only
      // way this file could go on asserting less than it means to. `gate.code`
      // is deliberately exempt: the guard's own code is already in `emitted` by
      // way of `counterGuardBody()` above.
      expect(
        found.unreadable,
        `${resolvedPath} has a code: this file cannot resolve to a literal — a new shape needs handling here, not skipping`,
      ).toEqual([]);

      for (const code of found.resolved) {
        emitted.add(code);
      }
    }
  }

  return [...emitted].sort();
}

// ---------------------------------------------------------------------------
// Reading the document
// ---------------------------------------------------------------------------

/**
 * Every path key under the top-level `paths:` block.
 *
 * Read as text rather than parsed, and scoped to the `paths:` block so a
 * `$ref` target or an example body cannot contribute a path. It ends at the next
 * top-level key, which is `components:`.
 */
function documentedPaths(): string[] {
  const spec = read(SPEC_PATH);
  // The top-level `paths:` block is every line after it that is indented or
  // blank, up to the next top-level key (`components:`). Blank lines have to be
  // inside the block: this file separates operations with blank lines, and a
  // pattern that required indentation on every line stopped at the first one and
  // returned only the first path.
  const block = /^paths:[ \t]*\n((?:^(?:[ \t].*)?\n)*)/m.exec(spec);
  expect(block, `${SPEC_PATH} has no top-level paths: block`).not.toBeNull();

  return [...block![1].matchAll(/^ {2}(\/\S*):[ \t]*$/gm)].map((match) => match[1]).sort();
}

/**
 * Every error code the document writes down.
 *
 * The document holds one invariant that makes this unambiguous: **every
 * single-quoted token in it that has the shape of an error code is an error
 * code**, and nothing else in the file may be written that way — not a constant
 * name, not a header, not an enum value. The header of `openapi.yaml` states the
 * same rule for whoever edits it next.
 *
 * That invariant is load-bearing and it is checked rather than assumed: the
 * precondition below asserts the documented set is exactly the codes named in
 * `ErrorCode.enum`, so a token that quietly stopped being an error code fails
 * here instead of narrowing the comparison for good.
 */
function documentedErrorCodes(): string[] {
  const spec = read(SPEC_PATH);
  return [...new Set([...spec.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]))].sort();
}

/** The codes the document lists as the closed set, read from `ErrorCode.enum`. */
function errorCodeEnumInSpec(): string[] {
  const spec = read(SPEC_PATH);
  const block = spec.slice(spec.indexOf('    ErrorCode:'));
  const untilSchemas = block.split(/\n {4}[A-Za-z]/)[0];
  return [...untilSchemas.matchAll(/^ {8}- '([^']+)'$/gm)].map((match) => match[1]).sort();
}

// ---------------------------------------------------------------------------

describe('the OpenAPI document describes the payment terminal integration', () => {
  it('reads every documented path and code, so nothing below passes on an empty read', () => {
    // The precondition, and it is a real one. Every assertion in this file is a
    // comparison between two extracted sets, and an empty extraction makes each
    // of them true without looking at anything — the failure mode
    // `migration-sql.test.ts` and
    // `wrangler-route-reachability.contract.test.ts` both guard against
    // explicitly, and for the same reason: a guard that reports green because it
    // stopped reading is worse than no guard, because it looks like coverage.
    expect(documentedPaths().length, `${SPEC_PATH} yielded no paths`).toBe(3);
    expect(documentedErrorCodes().length, `${SPEC_PATH} yielded no error codes`).toBeGreaterThan(0);
  });

  it('documents every route on the counter surface', () => {
    // The outward drift: the document naming a path no worker registers. An
    // integrator would build against it and get a gateway 404, which is
    // indistinguishable from the route not existing.
    expect(documentedPaths().filter((path) => !integrationSurface().includes(path))).toEqual([]);
  });

  it('documents nothing beyond the counter surface', () => {
    // The inward drift, and the direction that matters more here. A document
    // that quietly fell behind is not merely incomplete — it *looks* complete,
    // so the integrator concludes the surface is the three endpoints they can
    // see while a fourth exists that no client knows about.
    //
    // The derived set is what makes this bite: adding a route guarded by
    // `requireCounterSubject` lands here whether or not anybody remembers this
    // file or the document exists.
    expect(integrationSurface().filter((path) => !documentedPaths().includes(path))).toEqual([]);
  });

  it('resolves every route registration in the workers it reads', () => {
    // The precondition for the surface being derivable, and a real one.
    // `resolvePathArgument` drops anything it cannot resolve to a path literal,
    // so a registration moved behind a shape this extractor cannot follow would
    // quietly shorten the counter surface — and a route missing from the surface
    // is a route this file stops comparing against the document, which is the
    // exact failure mode it exists to catch.
    //
    // Both counts are asserted, and the first against zero, so an extractor that
    // stops finding anything is a failure rather than a pass.
    for (const worker of [IDENTITY_INDEX, GROWTH_ROUTES]) {
      expect(
        registrationsIn(worker).length,
        `${worker} has no readable app.<method>() registration — nothing was inspected`,
      ).toBeGreaterThan(0);
      expect(
        registeredRoutesIn(worker).length,
        `${worker} has a registration this file cannot resolve to a path literal`,
      ).toBe(registrationsIn(worker).length);
    }
  });

  it('mints a counter subject in exactly one route', () => {
    // The precondition for the surface being derivable rather than pinned. Two
    // callers of `counterSubject` would mean two places that know how to spell
    // `pos:<terminalId>`, which is precisely the disagreement that helper was
    // extracted to prevent — and the counter guard matches that spelling exactly,
    // so a typo in a second issuer would be a route that mints a token nothing
    // accepts.
    expect(counterIssuerRoutes().length).toBe(1);
  });

  it('guards the loyalty routes in the worker that serves them', () => {
    // Read separately from the two set comparisons so the failure names the
    // problem rather than reporting a symmetric difference. Both loyalty routes
    // are in `workers/growth`, reached through the gateway's `/v1/loyalty`
    // prefix; if the guard moved to another worker, the surface would still
    // balance and this is what would say so.
    expect(counterGuardedRoutes().sort()).toEqual([
      '/v1/loyalty/checkins',
      '/v1/loyalty/passes/resolve',
    ]);
  });
});

describe('the OpenAPI document only writes error codes the workers emit', () => {
  it('emits, from source, the codes the counter surface can answer with', () => {
    // Precondition for the comparison below: an empty emitted set satisfies
    // "every documented code is emitted" vacuously, which is the whole guard
    // going quiet.
    expect(emittedCounterCodes().length).toBeGreaterThan(0);
  });

  it('resolves every error code it documents to a code the workers emit', () => {
    // The requested direction. A code the document names but no worker emits
    // sends an integrator down a branch that can never happen, and — worse for
    // the integrator — one that looks reachable, because it is in the contract.
    expect(documentedErrorCodes().filter((code) => !emittedCounterCodes().includes(code))).toEqual(
      [],
    );
  });

  it('documents every error code the counter surface can answer with', () => {
    // The direction that is not requested and is still worth having: a new code
    // emitted by one of these routes and left out of the document is a client
    // that has no documented behaviour for a case it will actually meet.
    expect(emittedCounterCodes().filter((code) => !documentedErrorCodes().includes(code))).toEqual(
      [],
    );
  });

  it('keeps the documented code set equal to the closed enum', () => {
    // The invariant `documentedErrorCodes` relies on, asserted rather than
    // assumed. That function reads "every single-quoted token shaped like an
    // error code is an error code", so the two extractions are checked against
    // each other: if a code is added to an example but not to `ErrorCode.enum`,
    // or an enum entry loses its quotes and stops being extracted, the document
    // and the drift guard disagree about what they are protecting.
    expect(documentedErrorCodes()).toEqual(errorCodeEnumInSpec());
  });
});

describe('the OpenAPI document is about this integration', () => {
  it('documents no webhook receiver, because none exists', () => {
    // Stated as an assertion rather than left to prose, because the absence is
    // the single most likely thing to be documented by wishful thinking. A
    // reconciliation architecture is described under `POST /v1/loyalty/checkins`
    // in prose, and that is as far as it goes: there is no such endpoint in this
    // repository and none is served today. If one lands, it must be documented
    // and registered in the same change, and *this* test failing is the reminder
    // that the document was written without it.
    expect(documentedPaths().filter((path) => /webhook/i.test(path))).toEqual([]);
  });

  it('documents the token route as the only unauthenticated path', () => {
    // The credential exchange has to work before the caller has a token, and the
    // other two refuse anything that is not a counter subject. If the document
    // started presenting a loyalty route as callable without the bearer token, an
    // integrator would wire it and get `COUNTER_SUBJECT_REQUIRED` at runtime.
    const spec = read(SPEC_PATH);
    const anonymous = [...spec.matchAll(/^ {6}security: \[\]$/gm)];
    expect(anonymous.length, 'exactly one path may declare `security: []`').toBe(1);
    expect(spec.slice(0, spec.indexOf('\n  /v1/loyalty/passes/resolve:'))).toContain(
      'security: []',
    );
  });
});
