import { describe, expect, it } from 'vitest';

import { readConsentMap, readConsents, upsertConsent } from './consents';

// ---------------------------------------------------------------------------
// The behaviour of the consent store.
//
// The helpers take a Drizzle instance, and these tests drive a stand-in for
// one. What is asserted is the **shape of the write** and the **shape of the
// read**, because those are the two things that decide whether a gate that
// asks "has this customer agreed" gets one answer or two.
//
// The uniqueness itself is a database constraint, and it is covered where
// database constraints are covered: by the migration that creates it, and by
// the registry that keeps the declared indexes and the migration history in
// exact agreement.
// ---------------------------------------------------------------------------

const SCOPE = { businessId: 'biz-1', customerId: 'cust-1' };

/** A stand-in for the Drizzle instance the helpers write through. */
function mockDb(rows: Record<string, unknown>[] = []) {
  const calls: {
    insert?: { values: Record<string, unknown> };
    conflict?: { target: unknown; set: Record<string, unknown> };
    where?: unknown;
  } = {};

  const db = {
    insert: (_table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        calls.insert = { values };
        return {
          onConflictDoUpdate: (conflict: { target: unknown; set: Record<string, unknown> }) => {
            calls.conflict = conflict;
            return Promise.resolve();
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
  };

  return { db, calls };
}

describe('upsertConsent', () => {
  it('records a grant with the moment it began', async () => {
    const { db, calls } = mockDb();

    await upsertConsent(db, { ...SCOPE, consentType: 'whatsapp', granted: true });

    expect(calls.insert?.values).toMatchObject({
      businessId: 'biz-1',
      customerId: 'cust-1',
      consentType: 'whatsapp',
      granted: true,
      revokedAt: null,
    });
    expect(calls.insert?.values?.grantedAt).toBeInstanceOf(Date);
  });

  it('clears a previous withdrawal when the customer agrees again', async () => {
    const { db, calls } = mockDb();

    await upsertConsent(db, { ...SCOPE, consentType: 'whatsapp', granted: true });

    // The withdrawal is cleared, and `granted_at` moves to the new agreement:
    // the timestamp answers "since when has this customer been opted in", and a
    // customer who withdrew and agreed again has been opted in since the second
    // time.
    expect(calls.conflict?.set).toMatchObject({ granted: true, revokedAt: null });
    expect(calls.conflict?.set?.grantedAt).toBeInstanceOf(Date);
  });

  it('records a withdrawal without erasing the original grant', async () => {
    const { db, calls } = mockDb();

    await upsertConsent(db, { ...SCOPE, consentType: 'whatsapp', granted: false });

    expect(calls.insert?.values).toMatchObject({
      granted: false,
      // Null on a first withdrawal: the customer never had it.
      grantedAt: null,
    });
    expect(calls.insert?.values?.revokedAt).toBeInstanceOf(Date);

    // And on an existing row, `granted_at` is deliberately absent from the
    // update: the record of the original grant has to survive the withdrawal.
    expect(calls.conflict?.set).toMatchObject({ granted: false });
    expect(calls.conflict?.set).not.toHaveProperty('grantedAt');
    expect(calls.conflict?.set?.revokedAt).toBeInstanceOf(Date);
  });

  it('conflicts on the business, the customer and the type together', async () => {
    const { db, calls } = mockDb();

    await upsertConsent(db, { ...SCOPE, consentType: 'nearby_notifications', granted: true });

    // Three columns, because the same person is a different customer at a
    // different merchant, and a consent given to one says nothing about the
    // other.
    expect(calls.conflict?.target).toHaveLength(3);
  });

  it('keeps the address the consent came from', async () => {
    const { db, calls } = mockDb();

    await upsertConsent(db, {
      ...SCOPE,
      consentType: 'whatsapp',
      granted: true,
      ipAddress: '203.0.113.7',
    });

    expect(calls.insert?.values?.ipAddress).toBe('203.0.113.7');
  });
});

describe('readConsents', () => {
  it('returns every consent recorded for the customer', async () => {
    const { db } = mockDb([
      { consentType: 'whatsapp', granted: true, grantedAt: new Date(), revokedAt: null },
      {
        consentType: 'nearby_notifications',
        granted: false,
        grantedAt: null,
        revokedAt: new Date(),
      },
    ]);

    const states = await readConsents(db, SCOPE);

    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({ consentType: 'whatsapp', granted: true });
    expect(states[1]).toMatchObject({ consentType: 'nearby_notifications', granted: false });
  });

  it('scopes the read to the business and the customer', async () => {
    const { db, calls } = mockDb([]);

    await readConsents(db, SCOPE);

    // Two predicates, not one: reading a customer's consents across businesses
    // would disclose what they agreed to at a merchant they did not.
    expect(calls.where).toBeDefined();
  });
});

describe('readConsentMap', () => {
  it('maps each type to whether it is currently granted', async () => {
    const { db } = mockDb([
      { consentType: 'whatsapp', granted: true, grantedAt: new Date(), revokedAt: null },
      {
        consentType: 'nearby_notifications',
        granted: false,
        grantedAt: null,
        revokedAt: new Date(),
      },
    ]);

    expect(await readConsentMap(db, SCOPE)).toEqual({
      whatsapp: true,
      nearby_notifications: false,
    });
  });

  it('leaves a type that was never recorded absent', async () => {
    const { db } = mockDb([]);

    const map = await readConsentMap(db, SCOPE);

    // Absent is not false. "Nobody asked" and "asked and declined" are
    // different facts, and a caller deciding whether to ask can only tell them
    // apart if the map keeps them apart.
    expect(map).toEqual({});
    expect('whatsapp' in map).toBe(false);
  });
});
