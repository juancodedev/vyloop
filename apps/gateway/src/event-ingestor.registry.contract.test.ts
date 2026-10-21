/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// The event ingestor's event names are the deploy's, not the documentation's
// ---------------------------------------------------------------------------
//
// ## What this file is for
//
// `POST /v1/events/{type}` resolves `{type}` against `SCHEMA_REGISTRY` and
// answers **404 EVENT_TYPE_UNKNOWN** when the key is absent. The keys are not
// written by hand in the Worker: `register-schemas.ts` holds the list and
// `build-registry-payload.ts` turns it into the bulk-put payload the deploy
// job writes. So the list in that one array is the production surface.
//
// The documentation had drifted from it twice. It first promised `purchase`
// and `custom`, neither of which any revision of that array ever contained;
// then it was corrected to a lowercase spelling of schemas that exist, which is
// still wrong: KV keys are `PointsAssigned:latest`, not `points_assigned:latest`.
// A lowercase path answers 404 exactly like `purchase` did.
//
// ## Why the unit tests did not catch it
//
// `index.test.ts` mocks `SCHEMA_REGISTRY` with a namespace that returns the same
// schema for every key. That is the right mock for testing the ingestor's logic
// — auth, tenancy, body shapes, codes — and the wrong instrument for testing
// which keys exist, because a mock that answers everything cannot report that a
// name is absent. The name contract therefore lives here, against the array.
//
// ## Why the sources are read as text
//
// Same rule as `schema-registry-deploy.contract.test.ts` and
// `wallet-callback-path.contract.test.ts`: the assertion is about a literal list
// and a table of prose, not about a module's return value. Importing
// `register-schemas.ts` would drag the whole schema package into the gateway's
// test graph to read one array, and importing the docs is not possible at all.

const REPO_ROOT = join(__dirname, '..', '..', '..');

const registerSource = readFileSync(
  join(REPO_ROOT, 'packages', 'schema-registry', 'scripts', 'register-schemas.ts'),
  'utf8',
);

const apiDocs = readFileSync(join(REPO_ROOT, 'docs', '08-API-Design.md'), 'utf8');

/**
 * Every spec delta of the change that introduced this route. A delta is what a
 * reviewer reads to decide the change is correct, so a wrong path there is as
 * load-bearing as a wrong path in `docs/08` — and it is where the first
 * correction left `points_assigned` behind, green suite and all.
 */
const CHANGE_SPECS_DIR = join(
  REPO_ROOT,
  'openspec',
  'changes',
  'archive',
  '2026-10-21-api-surface-cleanup',
  'specs',
);

function changeSpecFiles(): string[] {
  return readdirSync(CHANGE_SPECS_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => join(CHANGE_SPECS_DIR, entry));
}

const ingestorSpec = readFileSync(
  join(REPO_ROOT, 'openspec', 'specs', 'event-ingestor', 'spec.md'),
  'utf8',
);

/**
 * Split a delta into its `#### Scenario:` blocks, each with the body that
 * follows it, so a check can reason about what one scenario asserts.
 */
function scenarios(text: string): string[] {
  const blocks = text.split(/^#### Scenario:/m).slice(1);
  return blocks.map((block) => block.split(/^#{2,4} /m)[0] ?? block);
}

/** The event types the deploy publishes, in source order. */
function publishedTypes(): string[] {
  return [...registerSource.matchAll(/eventType:\s*'([^']+)'/g)].map((match) => match[1]!);
}

/**
 * The event types `docs/08` tells a caller to post, read from its endpoint table.
 *
 * Table rows only: the prose below the table names `purchase` and `custom` on
 * purpose, as the two types that never existed, and a whole-document search
 * would read that warning as a promise.
 *
 * `health` is the probe, not a type, and it is the only path segment under
 * `/v1/events/` that is not resolved against the registry.
 */
function documentedTypes(): string[] {
  return [
    ...apiDocs.matchAll(/^\|\s*(?:POST|GET)\s*\|\s*`\/v1\/events\/([A-Za-z_][A-Za-z0-9_]*)`/gm),
  ]
    .map((match) => match[1]!)
    .filter((name) => name !== 'health');
}

describe('event ingestor registry contract', () => {
  it('publishes at least one type', () => {
    // A guard on the extraction itself: an empty list would make every
    // set-equality assertion below vacuously true.
    expect(publishedTypes().length).toBeGreaterThan(0);
  });

  it('documents exactly the types the deploy publishes', () => {
    expect([...documentedTypes()].sort()).toEqual([...publishedTypes()].sort());
  });

  it('keeps the spec naming every published type', () => {
    for (const type of publishedTypes()) {
      expect(ingestorSpec, `${type} is published but absent from the spec`).toContain(`\`${type}\``);
    }
  });

  it('names only published types in the change deltas, except where it asserts absence', () => {
    // A delta is what a reviewer reads to decide the change is correct, so a
    // wrong path there is as load-bearing as a wrong path in `docs/08`. The
    // first correction left `points_assigned` in the api-gateway delta while
    // every other source was right and the suite was green.
    //
    // Two shapes are legitimate and must not trip this: `health`, which is the
    // probe rather than a type, and a scenario that exists to prove a name is
    // *not* registered. The signal is `EVENT_TYPE_UNKNOWN`, the answer the route
    // gives for an absent key: "answers 404 rather than ..." is a promise about
    // a working path, while `THEN 404 EVENT_TYPE_UNKNOWN` is an assertion that
    // the key is missing.
    const published = publishedTypes();

    for (const file of changeSpecFiles()) {
      for (const scenario of scenarios(readFileSync(file, 'utf8'))) {
        const names = [...scenario.matchAll(/\/v1\/events\/([A-Za-z_][A-Za-z0-9_]*)/g)].map(
          (match) => match[1]!,
        );
        const assertsAbsence = scenario.includes('EVENT_TYPE_UNKNOWN');

        for (const name of names) {
          if (name === 'health' || assertsAbsence) {
            continue;
          }
          expect(published, `${file} promises /v1/events/${name}`).toContain(name);
        }
      }
    }
  });

  it('does not resurrect a type no revision of the registry had', () => {
    // These are the two names the first draft of `docs/08` promised. If one is
    // ever registered it becomes a deliberate decision, and this assertion is
    // the place that decision has to be recorded.
    for (const absent of ['purchase', 'custom']) {
      expect(publishedTypes()).not.toContain(absent);
      expect(apiDocs).not.toMatch(
        new RegExp(`^\\|\\s*POST\\s*\\|\\s*\`/v1/events/${absent}\``, 'm'),
      );
    }
  });

  it('registers no test_event, so the dev-queue branch stays dormant', () => {
    // The ingestor still publishes `test_event` to `EVENT_QUEUE`. That branch is
    // unreachable in production while no `test_event` key exists; asserting the
    // absence keeps the two facts tied together instead of leaving a reader to
    // assume the branch works end to end.
    expect(publishedTypes()).not.toContain('test_event');
  });
});
