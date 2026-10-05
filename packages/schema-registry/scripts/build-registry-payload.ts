/**
 * The KV bulk payload for the event schema registry.
 *
 * Exists because `SCHEMA_REGISTRY` is empty in production and nothing ever
 * filled it: the schemas are declared in `../src/index.ts`, `register-schemas`
 * knows how to put them in KV, and no workflow step ever called it. So
 * `POST /v1/events/:type` read `undefined` from the gateway (the binding was
 * undeclared) and would then have read an empty namespace (it is declared now,
 * and the namespace holds no keys), which is a 500 becoming a 404. Declaring the
 * binding is only half of the fix.
 *
 * ## Why this emits a file for `wrangler kv bulk put` instead of calling `put`
 *
 * One HTTP request, and the properties that matter come from the endpoint
 * rather than from this code:
 *
 * - **Non-destructive.** `wrangler kv bulk put` writes the pairs it is given
 *   and leaves every other key alone; `wrangler kv bulk delete` is a different
 *   command. Nothing here enumerates or truncates, so a key this script does not
 *   know about cannot be lost by running it. Verified against a local namespace
 *   seeded with an unrelated key: after a bulk put of the registry payload, that
 *   key was still there.
 * - **Idempotent.** The payload is a pure function of the schema source, so the
 *   same commit produces byte-identical output and writing the same key twice
 *   leaves the same state. No counter, no timestamp, nothing to accumulate.
 * - **Fails loudly.** A non-zero exit from `wrangler` fails the step, and the
 *   step blocks the deploy. That is the whole point: a deploy that goes green
 *   against an empty registry is how this bug survived a deploy in the first
 *   place.
 *
 * ## Why the keys are derived here rather than typed in
 *
 * `registerSchema` in `../src/index.ts` writes each schema under two keys,
 * `{eventType}:{version}` and `{eventType}:latest`, and `validate` reads
 * `{eventType}:latest`. This script builds the payload through that same
 * function against an in-memory namespace, so the keys it publishes are the keys
 * the reader looks up — derived once, in the module that owns the convention. A
 * hand-written list would be a second place to get it wrong, and the failure
 * would be a registry that looks populated and validates nothing.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

/** One entry in the array `wrangler kv bulk put` expects. */
export interface RegistryEntry {
  key: string;
  value: string;
}

/**
 * A `KVNamespace` that records writes instead of performing them.
 *
 * Only the surface `registerSchema` touches, and deliberately incomplete: if
 * registration ever starts deleting or enumerating as part of a write, this
 * throws rather than silently accepting it, and the deploy fails. An in-memory
 * namespace that implemented `delete` faithfully would be a namespace that can
 * lose a key it does not own.
 */
class RecordingNamespace {
  readonly entries = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(): Promise<void> {
    throw new Error('schema registration must never delete a key');
  }

  async list(): Promise<{ keys: Array<{ name: string }> }> {
    throw new Error('schema registration must never enumerate the namespace');
  }
}

/**
 * Every schema the registry publishes, as a bulk-put payload.
 *
 * Sorted by key so the output is byte-stable across runs. `wrangler` does not
 * care about order, but a diffable artifact is worth having in a deploy log and
 * worth having for the idempotency guard, which asserts that two calls produce
 * the same array rather than merely the same set.
 */
export async function buildRegistryPayload(): Promise<RegistryEntry[]> {
  const recording = new RecordingNamespace();
  const { registerAllSchemas } = await import('./register-schemas.ts');
  await registerAllSchemas(recording as unknown as KVNamespace);

  return [...recording.entries.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The payload as the JSON document `wrangler kv bulk put` reads.
 *
 * An array of `{key, value}` objects. An object keyed by the KV key is the
 * older shape and wrangler 4 rejects it outright — `Expected an array of
 * key-value objects but got type "object"` — which fails the step loudly rather
 * than writing nothing quietly.
 */
export function renderPayload(entries: RegistryEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}
