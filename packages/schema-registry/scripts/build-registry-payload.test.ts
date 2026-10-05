import type { KVNamespace } from '@cloudflare/workers-types';
import { Ajv } from 'ajv';
import { beforeEach, describe, expect, it } from 'vitest';

import { clearCache, validate } from '../src/index.ts';

import { buildRegistryPayload, renderPayload } from './build-registry-payload.ts';

// ---------------------------------------------------------------------------
// The payload the deploy step uploads to SCHEMA_REGISTRY
// ---------------------------------------------------------------------------
//
// This file is what makes "the deploy populates the registry" a claim rather
// than a hope. Three properties, each of which was load-bearing in the incident
// this change closes:
//
// 1. **It is a pure function of the source.** No clock, no counter, no
//    environment. Two runs produce identical bytes, which is what makes the
//    step safe to run on every deploy.
// 2. **The keys are the keys the reader looks up.** Derived by calling
//    `registerAllSchemas`, not typed out here.
// 3. **Every published schema is a schema that validates.** A registry holding
//    a schema that does not compile is worse than an empty one: the route would
//    stop answering 404 and start answering 500 on a real payload.

/** The five event types the registry is expected to serve. */
const EVENT_TYPES = [
  'CustomerRegistered',
  'PointsAssigned',
  'RewardRedeemed',
  'WhatsAppOutboundRequested',
  'WorkflowTriggered',
];

/**
 * A namespace that starts empty and accepts writes.
 *
 * The same shape `src/index.test.ts` uses, duplicated rather than imported so
 * this file asserts against the payload alone and cannot pass because of state
 * another test left behind.
 */
class MemKV {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Every key currently stored, so a test can assert on the whole namespace. */
  keys(): string[] {
    return [...this.store.keys()];
  }
}

/** A fresh empty namespace. */
function memKV(): MemKV {
  return new MemKV();
}

/** The `KVNamespace` surface `validate` and `registerSchema` use. */
function kv(namespace: MemKV = memKV()): KVNamespace {
  return namespace as unknown as KVNamespace;
}

/** A representative, valid payload for each of the five published schemas. */
const REPRESENTATIVE_PAYLOADS: Record<string, unknown> = {
  CustomerRegistered: {
    customer_id: '123e4567-e89b-12d3-a456-426614174000',
    full_name: 'Alice García',
    business_id: 'b0a1c2d3-e4f5-6789-abcd-ef0123456789',
  },
  PointsAssigned: {
    header: {
      business_id: 'b0a1c2d3-e4f5-6789-abcd-ef0123456789',
      timestamp: '2026-07-02T12:00:00Z',
      localization: { language: 'es-CL', timezone: 'America/Santiago' },
    },
    payload: {
      customer_id: '123e4567-e89b-12d3-a456-426614174000',
      points_assigned: 100,
      points_multiplier: 1.0,
      total_points: 500,
      reference_id: 'ref-001',
      assignment_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    },
  },
  RewardRedeemed: {
    header: {
      business_id: 'b0a1c2d3-e4f5-6789-abcd-ef0123456789',
      timestamp: '2026-07-02T12:00:00Z',
      localization: { language: 'es-CL', timezone: 'America/Santiago' },
    },
    payload: {
      customer_id: '123e4567-e89b-12d3-a456-426614174000',
      points_redeemed: 200,
      total_points_after: 300,
      reward_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      reward_name: 'Gift Card',
      partial: false,
      reference_id: 'ref-002',
      redemption_id: 'c4d5e6f7-8a9b-0c1d-2e3f-456789abcdef',
    },
  },
  WhatsAppOutboundRequested: {
    header: {
      business_id: 'b0a1c2d3-e4f5-6789-abcd-ef0123456789',
      timestamp: '2026-07-02T12:00:00Z',
      localization: { language: 'es-CL', timezone: 'America/Santiago' },
    },
    payload: {
      customer_id: '123e4567-e89b-12d3-a456-426614174000',
      business_id: 'b0a1c2d3-e4f5-6789-abcd-ef0123456789',
      template_name: 'order_ready',
      parameters: { first_name: 'Alice' },
      idempotency_key: 'wf-exec-001',
    },
  },
  WorkflowTriggered: {
    header: {
      business_id: 'b0a1c2d3-e4f5-6789-abcd-ef0123456789',
      timestamp: '2026-07-02T12:00:00Z',
      localization: { language: 'es-CL', timezone: 'America/Santiago' },
    },
    payload: {
      workflow_id: '11111111-2222-3333-4444-555555555555',
      customer_id: '123e4567-e89b-12d3-a456-426614174000',
      business_id: 'b0a1c2d3-e4f5-6789-abcd-ef0123456789',
      action_type: 'send_whatsapp',
      template_name: 'order_ready',
    },
  },
};

describe('the registry payload', () => {
  beforeEach(() => {
    clearCache();
  });

  it('publishes both the versioned and the latest key for each schema', async () => {
    // Both, because both are written and both are read. `validate` looks up
    // `{eventType}:latest`; a consumer pinned to a version looks up
    // `{eventType}:1.0.0`. Publishing only one would leave the other half of
    // the contract unfulfilled, and which half is broken would depend on the
    // caller rather than on the registry.
    const entries = await buildRegistryPayload();
    const keys = entries.map((entry) => entry.key);

    for (const eventType of EVENT_TYPES) {
      expect(keys, eventType).toContain(`${eventType}:1.0.0`);
      expect(keys, eventType).toContain(`${eventType}:latest`);
    }

    expect(entries).toHaveLength(EVENT_TYPES.length * 2);
  });

  it('writes the same bytes on a second run, because the deploy runs it every time', async () => {
    // THE idempotency guard. The step runs on every push to `main`, so a
    // payload that changed between runs would rewrite the registry with content
    // nobody reviewed, and a payload that accumulated would grow without bound.
    // Both are silent: the upload succeeds either way.
    const first = await buildRegistryPayload();
    const second = await buildRegistryPayload();

    expect(renderPayload(second)).toBe(renderPayload(first));
  });

  it('reaches the same state whether the namespace is empty or already populated', async () => {
    // The stronger half of idempotency, and the one that matters operationally.
    // Byte-identical output is necessary but not sufficient: it says the file is
    // stable, not that applying it twice is a no-op. So apply it twice to the
    // same namespace and assert the observable contents are unchanged, with a
    // key the payload does not own left alone — which is also the
    // non-destructiveness claim, since `wrangler kv bulk put` writes the pairs it
    // is given and nothing else.
    const namespace = memKV();
    const store = kv(namespace);

    const apply = async (): Promise<void> => {
      for (const { key, value } of await buildRegistryPayload()) {
        await store.put(key, value);
      }
    };

    await apply();
    await store.put('SOMEONE_ELSES_KEY', 'not ours');

    const afterFirst = namespace.keys().sort();
    await apply();
    const afterSecond = namespace.keys().sort();

    expect(afterSecond).toEqual(afterFirst);
    // A key this script does not know about survives. `bulk put` never deletes;
    // `bulk delete` is a different command and is not called anywhere near here.
    expect(afterSecond).toContain('SOMEONE_ELSES_KEY');
  });

  it('produces the array shape wrangler kv bulk put accepts', async () => {
    // wrangler 4 rejects a key-keyed object outright — `Expected an array of
    // key-value objects but got type "object"` — so this is asserting the file
    // format, not the content. Getting it wrong fails the deploy step loudly
    // rather than writing nothing quietly, but a loud failure on every deploy
    // is still a failure.
    const parsed = JSON.parse(renderPayload(await buildRegistryPayload()));

    expect(Array.isArray(parsed)).toBe(true);
    for (const item of parsed) {
      expect(Object.keys(item).sort()).toEqual(['key', 'value']);
      expect(typeof item.key).toBe('string');
      expect(typeof item.value).toBe('string');
    }
  });

  it('carries no TTL, because a schema that expires validates nothing', async () => {
    // `wrangler kv bulk put` accepts `--ttl` and `--expiration`. Neither is
    // passed, and asserting it here is the only way that stays true: an expired
    // `:latest` key turns the route back into `404 EVENT_TYPE_UNKNOWN` for every
    // real event type, days after a deploy that reported success.
    const parsed = JSON.parse(renderPayload(await buildRegistryPayload()));

    for (const item of parsed) {
      expect(Object.keys(item), item.key).toEqual(['key', 'value']);
    }
  });
});

describe('every schema the deploy publishes', () => {
  beforeEach(() => {
    clearCache();
  });

  it('compiles as a JSON Schema', async () => {
    // Ajv with no plugins, matching the instance `src/index.ts` builds. A schema
    // that does not compile is worse than a missing one: `validate` would throw
    // instead of returning `not found`, and the route would answer 500 on a real
    // payload — the exact symptom this change removes.
    const ajv = new Ajv({ strict: false });

    for (const { key, value } of await buildRegistryPayload()) {
      if (!key.endsWith(':latest')) continue;
      const schema = JSON.parse(value) as Record<string, unknown>;

      expect(() => ajv.compile(schema), key).not.toThrow();
    }
  });

  it('accepts a representative payload for each of the five event types', async () => {
    // End to end through the real reader: the payload the deploy writes, loaded
    // into a namespace, then `validate` called exactly as `ingestor.ts` calls
    // it. This is the assertion that a populated registry actually fixes the
    // route — the reason the deploy step exists at all.
    const store = kv();

    for (const { key, value } of await buildRegistryPayload()) {
      await store.put(key, value);
    }

    for (const eventType of EVENT_TYPES) {
      const result = await validate(store, eventType, REPRESENTATIVE_PAYLOADS[eventType]);
      expect(result.errors ?? [], eventType).toEqual([]);
      expect(result.valid, `${eventType}: ${result.errors?.join('; ')}`).toBe(true);
    }
  });

  it('still rejects a payload that does not match, because a registry that accepts everything is not validation', async () => {
    // The other direction, and the one that would let a typo in a schema ship
    // unnoticed: `additionalProperties: false` plus `required` means a payload
    // missing a required field has to fail. If this ever passes, a schema has
    // lost its constraints and the route is accepting events it should refuse.
    const store = kv();

    for (const { key, value } of await buildRegistryPayload()) {
      await store.put(key, value);
    }

    const result = await validate(store, 'CustomerRegistered', {
      customer_id: '123e4567-e89b-12d3-a456-426614174000',
      // full_name missing
      business_id: 'b0a1c2d3-e4f5-6789-abcd-ef0123456789',
    });

    expect(result.valid).toBe(false);
  });
});
