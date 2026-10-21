/// <reference types="node" />
import {
  clearCache,
  customerCheckedInSchema,
  customerRegisteredSchema,
  pointsAssignedSchema,
  pushCampaignRequestedSchema,
  pushNotificationRequestedSchema,
  registerSchema,
  rewardRedeemedSchema,
  whatsappOutboundRequestedSchema,
  workflowTriggeredSchema,
} from '@vyloop/schema-registry';
import { SignJWT } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import app from './index';

/**
 * The ingestor against the schemas the deploy publishes.
 *
 * `index.test.ts` drives the same route through a registry mock that answers
 * every key with one synthetic schema. That mock is what makes the logic cheap
 * to test, and also what hides any disagreement about *which* keys exist or what
 * shape each one accepts: a namespace that answers everything cannot report a
 * missing key, and a single schema cannot reject a real body.
 *
 * These tests register the eight exported schemas under their shipped names, so
 * the bodies below are the ones a caller must actually send.
 */

const SECRET = 'real-registry-test-secret';
const BUSINESS_ID = '12345678-1234-1234-1234-123456789abc';
const OTHER_BUSINESS_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CUSTOMER_ID = '123e4567-e89b-12d3-a456-426614174000';
const ASSIGNMENT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

/**
 * The eight types `packages/schema-registry/scripts/register-schemas.ts` puts in
 * KV, and the schema each one is registered with.
 */
const PUBLISHED = {
  CustomerCheckedIn: customerCheckedInSchema,
  CustomerRegistered: customerRegisteredSchema,
  PointsAssigned: pointsAssignedSchema,
  PushCampaignRequested: pushCampaignRequestedSchema,
  PushNotificationRequested: pushNotificationRequestedSchema,
  RewardRedeemed: rewardRedeemedSchema,
  WhatsAppOutboundRequested: whatsappOutboundRequestedSchema,
  WorkflowTriggered: workflowTriggeredSchema,
} as const;

/** A KV namespace that keeps what it is given, so the registry is real. */
class MemoryKV {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(): Promise<{ keys: Array<{ name: string }> }> {
    return { keys: [...this.store.keys()].map((name) => ({ name })) };
  }
}

type Sent = Record<string, unknown[]>;

function recordingQueue(sent: Sent, name: string) {
  return {
    send: async (event: unknown) => {
      (sent[name] ??= []).push(event);
    },
    sendBatch: async () => {},
  };
}

function env(kv: MemoryKV, sent: Sent) {
  return {
    JWT_SECRET: SECRET,
    RATE_LIMITER: { get: async () => null, put: async () => {}, delete: async () => {} },
    identity: { fetch: async () => new Response('{}', { status: 200 }) },
    customer: { fetch: async () => new Response('{}', { status: 200 }) },
    growth: { fetch: async () => new Response('{}', { status: 200 }) },
    SCHEMA_REGISTRY: kv,
    EVENT_QUEUE: recordingQueue(sent, 'dev'),
    DOMAIN_EVENTS_QUEUE: recordingQueue(sent, 'domain'),
  };
}

async function token(businessId = BUSINESS_ID): Promise<string> {
  return new SignJWT({
    sub: 'user_probe',
    business_id: businessId,
    role: 'admin',
    scopes: [],
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer('vyloop')
    .sign(new TextEncoder().encode(SECRET));
}

function headers(authorization?: string) {
  const result: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authorization) {
    result.Authorization = `Bearer ${authorization}`;
    result['X-Business-ID'] = BUSINESS_ID;
  }
  return result;
}

/** A body `PointsAssigned` accepts: the full envelope, exactly these fields. */
const pointsBody = JSON.stringify({
  header: {
    business_id: BUSINESS_ID,
    timestamp: '2026-07-02T12:00:00Z',
    localization: { language: 'es-CL', timezone: 'America/Santiago' },
  },
  payload: {
    customer_id: CUSTOMER_ID,
    points_assigned: 100,
    points_multiplier: 1,
    total_points: 500,
    reference_id: 'ref-probe',
    assignment_id: ASSIGNMENT_ID,
  },
});

/** A body `CustomerRegistered` accepts: the payload alone, no envelope. */
const bareCustomerBody = JSON.stringify({
  customer_id: CUSTOMER_ID,
  full_name: 'Probe Person',
  business_id: BUSINESS_ID,
});

describe('event ingestor against the published schemas', () => {
  const kv = new MemoryKV();

  beforeAll(async () => {
    for (const [eventType, schema] of Object.entries(PUBLISHED)) {
      await registerSchema(kv as never, eventType, schema as Record<string, unknown>, '1.0.0');
    }
  });

  beforeEach(() => {
    clearCache();
  });

  it('publishes an envelope to the domain queue and nothing to the dev queue', async () => {
    const sent: Sent = {};

    const res = await app.fetch(
      new Request('http://localhost/v1/events/PointsAssigned', {
        method: 'POST',
        headers: headers(await token()),
        body: pointsBody,
      }),
      env(kv, sent) as never,
    );

    expect(res.status).toBe(202);
    expect(sent.domain).toHaveLength(1);
    expect(sent.dev).toBeUndefined();
  });

  it('wraps a bare CustomerRegistered body as the payload, under the token business', async () => {
    const sent: Sent = {};

    const res = await app.fetch(
      new Request('http://localhost/v1/events/CustomerRegistered', {
        method: 'POST',
        headers: headers(await token()),
        body: bareCustomerBody,
      }),
      env(kv, sent) as never,
    );

    expect(res.status).toBe(202);
    expect(sent.domain).toHaveLength(1);
    expect(sent.dev).toBeUndefined();

    const [event] = sent.domain ?? [];
    const envelope = event as { header: { business_id: string }; payload: unknown };
    expect(envelope.header.business_id).toBe(BUSINESS_ID);
    expect(envelope.payload).toEqual(JSON.parse(bareCustomerBody));
  });

  it('refuses a tokenless write and publishes nothing', async () => {
    const sent: Sent = {};

    const res = await app.fetch(
      new Request('http://localhost/v1/events/PointsAssigned', {
        method: 'POST',
        headers: headers(),
        body: pointsBody,
      }),
      env(kv, sent) as never,
    );

    expect(res.status).toBe(401);
    expect((await res.json()) as unknown).toMatchObject({
      error: { code: 'AUTH_TOKEN_INVALID' },
    });
    expect(sent).toEqual({});
  });

  it('refuses a body naming another business and publishes nothing', async () => {
    const sent: Sent = {};

    const res = await app.fetch(
      new Request('http://localhost/v1/events/PointsAssigned', {
        method: 'POST',
        headers: headers(await token()),
        body: pointsBody.replaceAll(BUSINESS_ID, OTHER_BUSINESS_ID),
      }),
      env(kv, sent) as never,
    );

    expect(res.status).toBe(403);
    expect((await res.json()) as unknown).toMatchObject({
      error: { code: 'EVENT_BUSINESS_MISMATCH' },
    });
    expect(sent).toEqual({});
  });

  it('answers 404 for a type the deploy does not register', async () => {
    const sent: Sent = {};

    const res = await app.fetch(
      new Request('http://localhost/v1/events/test_event', {
        method: 'POST',
        headers: headers(await token()),
        body: JSON.stringify({
          header: { business_id: BUSINESS_ID },
          payload: { message: 'probe' },
        }),
      }),
      env(kv, sent) as never,
    );

    expect(res.status).toBe(404);
    expect((await res.json()) as unknown).toMatchObject({
      error: { code: 'EVENT_TYPE_UNKNOWN' },
    });
    expect(sent).toEqual({});
  });

  it('answers 404 for the lowercase spelling too', async () => {
    const sent: Sent = {};

    const res = await app.fetch(
      new Request('http://localhost/v1/events/points_assigned', {
        method: 'POST',
        headers: headers(await token()),
        body: pointsBody,
      }),
      env(kv, sent) as never,
    );

    expect(res.status).toBe(404);
    expect(sent).toEqual({});
  });
});
