/**
 * The campaign outcome queries, run on a real Postgres.
 *
 * `campaign-routes.test.ts` checks what the routes bind and return through a
 * mocked database, so it cannot tell whether the raw SQL in
 * `campaign-outcomes.ts` parses, or whether it counts what it claims to. This
 * file runs both queries on PGlite (Postgres compiled to WASM, in process),
 * with tables created from the Drizzle schema, against rows shaped the way
 * `push-delivery.ts` writes them: one row per attempt, keyed
 * `<campaign reference>:<subscription id>` in `content->>'reference_id'`.
 *
 * The tables come from the schema, not from the migrations: the migration
 * chain does not replay from an empty database (the `message_log` drift
 * tracked in `openspec/changes/message-log-schema-alignment`). Every column
 * these queries read is declared in the schema.
 */

// eslint-plugin-import cannot parse PGlite's bundled type declarations; the
// import itself is checked by tsc.
// eslint-disable-next-line import/namespace
import { PGlite } from '@electric-sql/pglite';
import * as schema from '@vyloop/db';
import { customers, messageLog, tenants } from '@vyloop/db';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readCampaignFailures, readCampaignOutcomes } from './campaign-outcomes';

const BIZ = '00000000-0000-4000-8000-0000000000b1';
const OTHER_BIZ = '00000000-0000-4000-8000-0000000000b2';
const ANA = '00000000-0000-4000-8000-0000000000c1';
const PEDRO = '00000000-0000-4000-8000-0000000000c2';
const OUTSIDER = '00000000-0000-4000-8000-0000000000c9';

const pg = new PGlite();
const db = drizzle(pg);

/** One delivery attempt, as `push-delivery.ts` records it. */
function attempt(
  referenceId: string,
  status: 'queued' | 'sent' | 'failed',
  at: string,
  overrides: Partial<typeof messageLog.$inferInsert> = {},
): typeof messageLog.$inferInsert {
  return {
    businessId: BIZ,
    customerId: ANA,
    direction: 'outbound',
    channel: 'push',
    status,
    content: { reference_id: referenceId, title: 'Café al 2x1' },
    metadata: status === 'failed' ? { error: 'push service returned 410' } : {},
    createdAt: new Date(at),
    ...overrides,
  };
}

beforeAll(async () => {
  const { pushSchema } = await import('drizzle-kit/api');
  const tables = Object.fromEntries(
    Object.entries(schema).filter(
      ([, value]) =>
        value !== null &&
        typeof value === 'object' &&
        Symbol.for('drizzle:IsDrizzleTable') in (value as object),
    ),
  );
  const { apply } = await pushSchema(tables, db as never);
  await apply();

  await db.insert(tenants).values([
    { id: BIZ, name: 'Café Central', slug: 'cafe-central' },
    { id: OTHER_BIZ, name: 'Otro Café', slug: 'otro-cafe' },
  ]);
  await db.insert(customers).values([
    { id: ANA, businessId: BIZ, fullName: 'Ana Rojas', phone: '+56911111111' },
    { id: PEDRO, businessId: BIZ, fullName: 'Pedro Soto', phone: '+56922222222' },
    { id: OUTSIDER, businessId: OTHER_BIZ, fullName: 'Fuera', phone: '+56999999999' },
  ]);

  await db.insert(messageLog).values([
    // promo-1: A sent, B failed, C still queued, D sent on its retry,
    // E failed on both of its attempts.
    attempt('promo-1:sub-a', 'sent', '2026-10-28T12:00:00Z'),
    attempt('promo-1:sub-b', 'failed', '2026-10-28T12:01:00Z', { customerId: PEDRO }),
    attempt('promo-1:sub-c', 'queued', '2026-10-28T12:02:00Z'),
    attempt('promo-1:sub-d', 'queued', '2026-10-28T12:03:00Z'),
    attempt('promo-1:sub-d', 'sent', '2026-10-28T12:04:00Z'),
    attempt('promo-1:sub-e', 'failed', '2026-10-28T12:05:00Z'),
    attempt('promo-1:sub-e', 'failed', '2026-10-28T12:06:00Z', {
      metadata: { error: 'The browser is no longer registered for push.' },
    }),
    // Another business's rows under the same reference: never counted.
    attempt('promo-1:sub-x', 'sent', '2026-10-28T12:07:00Z', {
      businessId: OTHER_BIZ,
      customerId: OUTSIDER,
    }),
    attempt('promo-1:sub-y', 'failed', '2026-10-28T12:08:00Z', {
      businessId: OTHER_BIZ,
      customerId: OUTSIDER,
    }),
    // A reference that merely starts with another one's text.
    attempt('promo-10:sub-a', 'sent', '2026-10-28T12:09:00Z'),
    // A reference with LIKE wildcards, compared literally.
    attempt('50%_off:sub-a', 'failed', '2026-10-28T12:10:00Z'),
    // A WhatsApp row with a push-shaped reference: not a push delivery.
    attempt('promo-1:sub-w', 'sent', '2026-10-28T12:11:00Z', { channel: 'whatsapp' }),
  ]);
}, 120_000);

afterAll(async () => {
  await pg.close();
});

describe('readCampaignOutcomes on Postgres', () => {
  it('counts one delivery per subscription, by its final outcome', async () => {
    const outcomes = await readCampaignOutcomes(db, BIZ, ['promo-1']);

    expect(outcomes.get('promo-1')).toEqual({ delivered: 2, failed: 2, pending: 1 });
  });

  it('keeps each campaign to its own reference and business', async () => {
    const outcomes = await readCampaignOutcomes(db, BIZ, ['promo-1', 'promo-10', '50%_off', '50']);

    expect(outcomes.get('promo-10')).toEqual({ delivered: 1, failed: 0, pending: 0 });
    expect(outcomes.get('50%_off')).toEqual({ delivered: 0, failed: 1, pending: 0 });
    expect(outcomes.get('50')).toEqual({ delivered: 0, failed: 0, pending: 0 });
    expect((await readCampaignOutcomes(db, OTHER_BIZ, ['promo-1'])).get('promo-1')).toEqual({
      delivered: 1,
      failed: 1,
      pending: 0,
    });
  });

  it('reports a campaign with no deliveries as zeros', async () => {
    const outcomes = await readCampaignOutcomes(db, BIZ, ['nobody-got-this']);

    expect(outcomes.get('nobody-got-this')).toEqual({ delivered: 0, failed: 0, pending: 0 });
  });
});

describe('readCampaignFailures on Postgres', () => {
  it('lists each failed delivery once, newest first, with its customer and latest reason', async () => {
    const failures = await readCampaignFailures(db, BIZ, 'promo-1');

    expect(failures).toEqual([
      {
        customer_name: 'Ana Rojas',
        error: 'The browser is no longer registered for push.',
        created_at: '2026-10-28T12:06:00.000Z',
      },
      {
        customer_name: 'Pedro Soto',
        error: 'push service returned 410',
        created_at: '2026-10-28T12:01:00.000Z',
      },
    ]);
  });

  it('leaves out a delivery that a later attempt sent', async () => {
    await db
      .insert(messageLog)
      .values([
        attempt('promo-2:sub-a', 'failed', '2026-10-28T13:00:00Z'),
        attempt('promo-2:sub-a', 'sent', '2026-10-28T13:01:00Z'),
      ]);

    expect(await readCampaignFailures(db, BIZ, 'promo-2')).toEqual([]);
  });

  it('honours the limit', async () => {
    expect(await readCampaignFailures(db, BIZ, 'promo-1', 1)).toHaveLength(1);
  });
});
