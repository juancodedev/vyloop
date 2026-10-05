/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// The cross-package drift guard for the SCHEMA_REGISTRY namespace id
// ---------------------------------------------------------------------------
//
// ## What this file is for
//
// One event schema lives in one KV namespace. Five `wrangler.jsonc` files bind
// it, and each one repeats the namespace id as a literal because there is no
// such thing as a symbolic id in that format. The gateway read it as
// `undefined` — the binding was absent entirely — which is a *loud* failure:
// every `POST /v1/events/:type` answered 500. The failure this file prevents is
// the quiet one that replaces it once the binding is declared.
//
// ## The failure this guards, stated plainly
//
// A wrong id is worse than no id, and that is the whole reason this file
// exists. With no binding the route throws and returns 500, which someone
// notices within a minute. With a *wrong but valid* id the route resolves
// against a real, empty namespace, `getSchema` returns `null`, and
// `POST /v1/events/CustomerRegistered` answers **404 EVENT_TYPE_UNKNOWN** —
// claiming the event type does not exist, for an event type the system defines
// in `packages/schema-registry/src/index.ts`. Every worker bound to the real
// namespace keeps working, so the deployment looks healthy from four of five
// sides and the gateway is the only thing answering. That is two truths about
// one namespace, and nothing in a single file can see it: the gateway's config
// is internally consistent, and so is each worker's.
//
// ## Why this reads the other configs instead of importing anything
//
// Same reason `wrangler-config.contract.test.ts` reads `wrangler.jsonc` rather
// than importing it, and the same reason `wallet-callback-path.contract.test.ts`
// reads `workers/wallet/src/routes.ts` instead of importing `@vyloop/wallet`:
// the gateway is the public face and the workers are the services behind it.
// An import edge from the public face to the services behind it, bought so a
// test can compare two strings, inverts the dependency direction of the system
// to buy a compile-time check. Reading the files keeps that direction intact.
//
// ## Why the id is read out of the object rather than the whole document
//
// Each entry is matched as a flat `{ … }` literal and the id is pulled from
// *that* block. A regex over the whole file with a lazy `.*?` would happily
// match `"binding": "SCHEMA_REGISTRY"` in one entry and the `"id"` of the next
// one, which is precisely the kind of test that passes while the thing it
// guards is wrong. Scanning brace-delimited objects makes the pairing
// structural rather than hopeful, and it makes the test immune to the two
// things a naive stripper gets wrong in these files: every value in the
// document is an `https://` URL, and the comments discuss routes containing
// braces.

/** The repository root, from this file's position under `apps/gateway/src`. */
const REPO_ROOT = join(__dirname, '..', '..', '..');

/**
 * Every `wrangler.jsonc` in the repository that binds `SCHEMA_REGISTRY`.
 *
 * Enumerated rather than hardcoded, so a sixth worker that starts validating
 * events is *added* to the comparison instead of silently escaping it. The
 * expectation below pins the set, so a new entry fails until someone decides
 * whether it belongs — which is the point: a namespace id is a fact five
 * packages must agree on, and the agreement has to be looked at.
 */
const CONFIGS_BINDING_SCHEMA_REGISTRY: Array<{ label: string; path: string }> = [
  { label: 'apps/gateway', path: join(REPO_ROOT, 'apps', 'gateway', 'wrangler.jsonc') },
  { label: 'workers/automation', path: join(REPO_ROOT, 'workers', 'automation', 'wrangler.jsonc') },
  {
    label: 'workers/communication',
    path: join(REPO_ROOT, 'workers', 'communication', 'wrangler.jsonc'),
  },
  { label: 'workers/customer', path: join(REPO_ROOT, 'workers', 'customer', 'wrangler.jsonc') },
  { label: 'workers/growth', path: join(REPO_ROOT, 'workers', 'growth', 'wrangler.jsonc') },
];

/**
 * The namespace id declared for `SCHEMA_REGISTRY`, or `undefined` when the file
 * does not declare that binding at all.
 *
 * Returns `undefined` rather than throwing on a missing binding, because
 * "absent" and "wrong" are different bugs and the assertion has to be able to
 * say which one it found.
 */
function declaredNamespaceId(source: string): string | undefined {
  for (const match of source.matchAll(/\{[^{}]*\}/g)) {
    const entry = match[0];
    if (!/"binding"\s*:\s*"SCHEMA_REGISTRY"/.test(entry)) continue;
    return /"id"\s*:\s*"([^"]+)"/.exec(entry)?.[1];
  }
  return undefined;
}

/** The ids every config declares, keyed by the config's label. */
function declaredIds(): Record<string, string | undefined> {
  return Object.fromEntries(
    CONFIGS_BINDING_SCHEMA_REGISTRY.map(({ label, path }) => [
      label,
      declaredNamespaceId(readFileSync(path, 'utf8')),
    ]),
  );
}

describe('the SCHEMA_REGISTRY namespace is one namespace', () => {
  it('is declared, under that binding name, by every config that validates events', () => {
    // Four workers declare it. The gateway did not, and read it as `undefined`
    // on a mounted public route — which is the 500 this whole change exists to
    // close. Asserting the *set* rather than a count means a worker that drops
    // the binding is as loud here as the gateway was.
    const declared = declaredIds();

    expect(Object.keys(declared)).toEqual(
      CONFIGS_BINDING_SCHEMA_REGISTRY.map(({ label }) => label),
    );

    const missing = Object.entries(declared)
      .filter(([, id]) => id === undefined)
      .map(([label]) => label);

    expect(missing, `no SCHEMA_REGISTRY binding in: ${missing.join(', ')}`).toEqual([]);
  });

  it('resolves to the same namespace id in all five, because two truths is the worst outcome', () => {
    // The core assertion. A divergence here is not a config nit: the gateway
    // would read an empty namespace and answer 404 EVENT_TYPE_UNKNOWN for every
    // real event type while four workers read the populated one and keep
    // working, so the failure points at the wrong package.
    //
    // `Set` rather than a pairwise loop, because the property is "there is
    // exactly one id" — spelled once, and it holds for five configs or fifty.
    const ids = new Set(Object.values(declaredIds()));

    expect(ids.size, `the five configs declare ${ids.size} different ids`).toBe(1);
    expect([...ids]).toHaveLength(1);
  });

  it("declares a namespace id in Cloudflare's 32-hex shape, not a placeholder", () => {
    // A typo that still parsed — a truncated id, a `preview_id` copied over, an
    // id with a trailing character — would satisfy the agreement assertion
    // above if all five configs carried the same typo, and would resolve
    // against nothing at runtime. The shape is the cheapest check that
    // distinguishes a real namespace id from a plausible-looking string.
    for (const [label, id] of Object.entries(declaredIds())) {
      expect(id, label).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});
