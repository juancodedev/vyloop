/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// The consumer is wired.
//
// This worker has exported a `queue` handler for a long time, and for all of
// that time it consumed **nothing**: `wrangler.jsonc` declared the domain
// events queue as a producer only, so Cloudflare never attached a consumer to
// it. The handler was correct, the routes were correct, the tests were green,
// and the queue was never read.
//
// A worker that exports `queue` and is not attached to a queue is not a
// consumer. It is a function nobody calls. The wiring is the whole difference
// between "the event is handled" and "the event is handled in a place where
// nobody can observe it".
//
// This file is the guard for that. It is cheap, it reads the same files the
// deploy reads, and it fails the moment the wiring is removed — which is the
// only moment it matters, because the removal is silent.
// ---------------------------------------------------------------------------

const here = fileURLToPath(new URL('.', import.meta.url));
const workerRoot = join(here, '..');

const wranglerSource = readFileSync(join(workerRoot, 'wrangler.jsonc'), 'utf8');
const indexSource = readFileSync(join(workerRoot, 'src', 'index.ts'), 'utf8');

/** The queue every worker publishes domain events to. */
const DOMAIN_EVENTS_QUEUE = 'vyloop-domain-events';

describe('the communication worker consumes the domain events queue', () => {
  it('declares a consumer for the queue it produces to', () => {
    // A consumer on a *different* queue is as broken as no consumer at all:
    // the events are published to one queue and read from another, and the
    // symptom is silence.
    expect(wranglerSource).toContain('"consumers"');
    expect(wranglerSource).toContain(`"queue": "${DOMAIN_EVENTS_QUEUE}"`);
  });

  it('consumes the same queue it produces to', () => {
    const produced = /"producers"\s*:\s*\[[\s\S]*?"queue"\s*:\s*"([^"]+)"/.exec(wranglerSource);
    const consumed = /"consumers"\s*:\s*\[[\s\S]*?"queue"\s*:\s*"([^"]+)"/.exec(wranglerSource);

    expect(produced?.[1], 'the producer queue could not be read').toBe(DOMAIN_EVENTS_QUEUE);
    expect(consumed?.[1], 'the consumer queue could not be read').toBe(produced?.[1]);
  });

  it('exports the handler Cloudflare calls', () => {
    // The export is what makes the worker a consumer at all. The config
    // without it is a queue nobody reads, and the export without the config is
    // a handler nobody calls; both are broken and only one of them looks
    // right in review.
    expect(indexSource).toMatch(/export\s*\{\s*queue\s*\}/);
    expect(indexSource).toMatch(/export\s+default\s*\{[^}]*queue/);
  });

  it('routes the consumed events through the shared envelope contract', () => {
    // The handler has to unwrap the envelope the producers publish, or it
    // receives an object it cannot read.
    expect(indexSource).toContain('consume');
    expect(indexSource).toContain('handleEvent');
  });
});
