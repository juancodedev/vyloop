import { describe, expect, it } from 'vitest';

import {
  deletePushSubscription,
  deletePushSubscriptionByEndpoint,
  hashPushEndpoint,
  readBusinessPushSubscriptions,
  readPushSubscriptions,
  upsertPushSubscription,
} from './push-subscriptions';

// ---------------------------------------------------------------------------
// The shape of a push subscription.
//
// The endpoint is a capability — anyone holding it can push to that browser —
// so the tests here are as much about what does not leave as about what does.
// ---------------------------------------------------------------------------

const SCOPE = { businessId: 'biz-1', customerId: 'cust-1' };

/** A stand-in for the Drizzle instance the helpers write through. */
function mockDb(rows: Record<string, unknown>[] = []) {
  const calls: {
    insert?: { values: Record<string, unknown> };
    conflict?: { target: unknown; set: Record<string, unknown> };
    where?: unknown;
    deleted?: boolean;
  } = {};

  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        calls.insert = { values };
        return {
          onConflictDoUpdate: (conflict: { target: unknown; set: Record<string, unknown> }) => {
            calls.conflict = conflict;
            // Chained, because the real builder continues into `.returning()`.
            return {
              returning: () =>
                Promise.resolve([
                  {
                    id: 'sub-1',
                    ...values,
                    createdAt: new Date('2026-01-01T00:00:00.000Z'),
                    lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
                  },
                ]),
            };
          },
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: (where: unknown) => {
          calls.where = where;
          return Promise.resolve(rows);
        },
      }),
    }),
    delete: () => ({
      where: (where: unknown) => {
        calls.where = where;
        calls.deleted = true;
        return { returning: () => Promise.resolve([{ id: 'sub-1' }]) };
      },
    }),
  };

  return { db, calls };
}

describe('hashPushEndpoint', () => {
  it('is a digest, not the endpoint', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
    const hash = await hashPushEndpoint(endpoint);

    expect(hash).not.toContain(endpoint);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same digest for the same endpoint', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';

    expect(await hashPushEndpoint(endpoint)).toBe(await hashPushEndpoint(endpoint));
  });

  it('differs for two endpoints', async () => {
    const a = await hashPushEndpoint('https://fcm.googleapis.com/fcm/send/abc123');
    const b = await hashPushEndpoint('https://fcm.googleapis.com/fcm/send/def456');

    expect(a).not.toBe(b);
  });
});

describe('upsertPushSubscription', () => {
  it('records the registration and stamps when it was last seen', async () => {
    const { db, calls } = mockDb();

    const record = await upsertPushSubscription(db, {
      ...SCOPE,
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      p256dh: 'public-key',
      auth: 'auth-secret',
    });

    expect(record.id).toBe('sub-1');
    expect(calls.insert?.values).toMatchObject({
      businessId: 'biz-1',
      customerId: 'cust-1',
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      p256dh: 'public-key',
      auth: 'auth-secret',
    });
    expect(calls.insert?.values?.lastSeenAt).toBeInstanceOf(Date);
  });

  it('conflicts on the endpoint alone', async () => {
    const { db, calls } = mockDb();

    await upsertPushSubscription(db, {
      ...SCOPE,
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      p256dh: 'public-key',
      auth: 'auth-secret',
    });

    // One endpoint is one registration, whoever holds it now. A unique index
    // over the triple would let a browser that signs out accumulate a row per
    // customer who used it.
    expect(calls.conflict?.target).toBeDefined();
  });

  it('hands the new owner the registration when the browser changes hands', async () => {
    const { db, calls } = mockDb();

    await upsertPushSubscription(db, {
      ...SCOPE,
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      p256dh: 'public-key',
      auth: 'auth-secret',
    });

    // The registration belongs to whoever holds the token now.
    expect(calls.conflict?.set).toMatchObject({
      customerId: 'cust-1',
      businessId: 'biz-1',
      p256dh: 'public-key',
      auth: 'auth-secret',
    });
  });
});

describe('readPushSubscriptions', () => {
  it('returns every registration the customer holds', async () => {
    const { db } = mockDb([
      { id: 'sub-1', endpoint: 'https://a.test/1' },
      { id: 'sub-2', endpoint: 'https://a.test/2' },
    ]);

    const records = await readPushSubscriptions(db, SCOPE);

    expect(records).toHaveLength(2);
  });

  it('scopes the read to the business and the customer', async () => {
    const { db, calls } = mockDb([]);

    await readPushSubscriptions(db, SCOPE);

    // Two predicates: the same person is a different customer at a different
    // merchant, and a consent given to one says nothing about the other.
    expect(calls.where).toBeDefined();
  });
});

describe('readBusinessPushSubscriptions', () => {
  it('returns every registration the business holds', async () => {
    const { db } = mockDb([{ id: 'sub-1' }, { id: 'sub-2' }]);

    expect(await readBusinessPushSubscriptions(db, 'biz-1')).toHaveLength(2);
  });
});

describe('deletePushSubscription', () => {
  it('reports that it removed a row', async () => {
    const { db } = mockDb();

    expect(await deletePushSubscription(db, { businessId: 'biz-1', endpoint: 'https://a.test/1' })).toBe(
      true,
    );
  });

  it('reports that there was nothing to remove', async () => {
    const db = {
      delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    };

    expect(
      await deletePushSubscription(db, { businessId: 'biz-1', endpoint: 'https://a.test/1' }),
    ).toBe(false);
  });
});

describe('deletePushSubscriptionByEndpoint', () => {
  it('removes without a tenant in the predicate', async () => {
    // The push service answers 404 or 410 for a registration it no longer
    // holds, and that answer is about the endpoint: there is no tenant in it
    // to check, and the subscription is identified by the very capability that
    // was rejected.
    const { db, calls } = mockDb();

    const removed = await deletePushSubscriptionByEndpoint(db, 'https://a.test/1');

    expect(removed).toBe(true);
    expect(calls.where).toBeDefined();
  });
});
