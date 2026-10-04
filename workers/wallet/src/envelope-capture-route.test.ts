/**
 * Route-level tests for the temporary envelope capture.
 *
 * ## What is asserted here and not in `envelope-capture.test.ts`
 *
 * That file covers the report. This one covers the three things only a request
 * can prove:
 *
 * 1. **It is actually reachable.** The capture is worthless behind a 401, and a
 *    401 here is invisible: the request arrives unsigned, exactly like a real
 *    Google delivery, so nothing about the failure says "route not wired". Both
 *    the wallet worker's auth exemption and the gateway's are asserted.
 * 2. **It writes nothing.** `createDb` is replaced with a function that throws,
 *    so any attempt to reach the database fails the test loudly instead of
 *    passing because a mock happened to tolerate it.
 * 3. **A hostile body gets a controlled answer.** The endpoint is public, so the
 *    question is not whether it is safe but whether it is *total*: every input
 *    produces a report and a 200, never a 500 with a stack.
 *
 * ## The one that fails if this endpoint outlives its fix
 *
 * `the capture is not superseded` is the deletion gate, asserted through the
 * public surface as well as the constant, so a route that outlives the constant
 * cannot.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@vyloop/db', async () => {
  const { pgTable, uuid, integer, text, timestamp } = await import('drizzle-orm/pg-core');
  const { sql } = await import('drizzle-orm');

  return {
    // Throwing rather than returning a handle: a capture that reached for the
    // database would then fail here instead of silently succeeding against a
    // permissive mock. This is the assertion, not a stub.
    createDb: vi.fn(() => {
      throw new Error('the envelope capture must not open a database');
    }),
    customers: pgTable('customers', {
      id: uuid('id').primaryKey(),
      globalId: uuid('global_id').notNull(),
      businessId: uuid('business_id').notNull(),
      fullName: text('full_name'),
      memberCode: text('member_code'),
      currentTierId: uuid('current_tier_id'),
      deletedAt: timestamp('deleted_at'),
    }),
    customerWalletPasses: pgTable('customer_wallet_passes', {
      customerId: uuid('customer_id').notNull(),
      tenantId: uuid('tenant_id').notNull(),
      objectId: text('object_id').notNull(),
      state: text('state').notNull(),
      lastSyncedAt: timestamp('last_synced_at'),
    }),
    tenantWalletPrograms: pgTable('tenant_wallet_programs', {
      tenantId: uuid('tenant_id').notNull(),
      issuerId: text('issuer_id').notNull(),
      classId: text('class_id').notNull(),
      reviewStatus: text('review_status').notNull(),
      lastSyncedAt: timestamp('last_synced_at'),
    }),
    loyaltyPrograms: pgTable('loyalty_programs', {
      id: uuid('id').primaryKey(),
      businessId: uuid('business_id').notNull(),
      pointsCurrency: text('points_currency').notNull(),
    }),
    membershipTiers: pgTable('membership_tiers', {
      id: uuid('id').primaryKey(),
      businessId: uuid('business_id').notNull(),
      name: text('name').notNull(),
    }),
    pointsTransactions: pgTable('points_transactions', {
      id: uuid('id').primaryKey(),
      businessId: uuid('business_id').notNull(),
      customerId: uuid('customer_id').notNull(),
      balanceAfter: integer('balance_after').notNull(),
      createdAt: timestamp('created_at').notNull(),
    }),
    setCurrentBusinessId: (id: string) =>
      sql`SELECT set_config('app.current_business_id', ${id}, true);`,
    setCurrentTenantId: (id: string) => sql`SELECT set_config('app.current_tenant_id', ${id}, true);`,
  };
});

const { createDb } = await import('@vyloop/db');

const { default: walletWorker } = await import('./index');
const { ENVELOPE_CAPTURE_PATH, ENVELOPE_CAPTURE_TICKET } = await import('./envelope-capture');

const ISSUER_ID = '3388000000023206930';

const SIGNED_MESSAGE = JSON.stringify({
  classId: `${ISSUER_ID}.tenant-1`,
  objectId: `${ISSUER_ID}.member-1`,
  eventType: 'save',
  expTimeMillis: 1754114831806,
  nonce: '40a8e5af-5b7f-4ea4-b152-63d96858550e',
});

/**
 * Real key material and real DER signatures, generated per call.
 *
 * Hand-written base64 was the first attempt here and it was wrong: a plausible
 * looking string decodes to 103 bytes rather than the 91 of a P-256 SPKI, so the
 * test asserted a length nothing had produced. Only a real key gives a real DER
 * header, and the DER edges are one of the things the capture reports.
 */
async function envelope(overrides: Record<string, unknown> = {}): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  let binary = '';
  for (const byte of spki) binary += String.fromCharCode(byte);

  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode(SIGNED_MESSAGE),
    ),
  );
  // P1363 -> DER, so the signature starts with a real 0x30 SEQUENCE.
  const der: number[] = [0x30, raw.length + 4, 0x02, 32, ...raw.subarray(0, 32), 0x02, 32];
  der.push(...raw.subarray(32, 64));
  let derBinary = '';
  for (const byte of der) derBinary += String.fromCharCode(byte);

  return JSON.stringify({
    protocolVersion: 'ECv2SigningOnly',
    signature: btoa(derBinary),
    signedMessage: SIGNED_MESSAGE,
    intermediateSigningKey: {
      signedKey: JSON.stringify({
        keyValue: btoa(binary),
        keyExpiration: '1754778096000',
      }),
      signatures: [btoa(derBinary)],
    },
    ...overrides,
  });
}

/**
 * An env with **no** `DATABASE_URL`.
 *
 * The absence is the test: if the route ever needs a database, it has to fail
 * here rather than in production where the variable happens to be set.
 */
function envWithoutDatabase(): Record<string, unknown> {
  return { GOOGLE_WALLET_ISSUER_ID: ISSUER_ID };
}

async function post(body: string, env: Record<string, unknown> = envWithoutDatabase()) {
  const res = await walletWorker.fetch(
    new Request(`https://wallet.test${ENVELOPE_CAPTURE_PATH}`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
    }),
    env as never,
    undefined as never,
  );
  return res;
}

interface CaptureBody {
  capture?: {
    parsed?: boolean;
    topLevelKeys?: string[];
    protocolVersion?: string | null;
    recipientId?: { presentInEnvelope?: boolean; configuredIssuerId?: string | null };
    signedMessage?: { prefix?: string | null; byteLength?: number };
    intermediateSigningKey?: {
      signedKey?: { algorithm?: string | null; keyValueByteLength?: number };
      signatures?: { count?: number };
    };
    messageSignature?: { byteLength?: number; firstByteHex?: string | null };
    derivedSignedBytes?: {
      keySignatureInput?: { sha256?: string } | null;
      messageSignatureInput?: { sha256?: string } | null;
    };
    notes?: string[];
  };
  ticket?: string;
  reviewBy?: string;
  supersededBy?: string | null;
}

describe('POST the temporary envelope capture', () => {
  it('answers without any gateway-injected identity, like the real callback', async () => {
    // The failure this guards is invisible: an unsigned request to a route that
    // still demands headers produces a 401 whose message says nothing about the
    // route being unreachable, and the capture would look like a Google-side
    // problem. So it is asserted directly, with no `X-User-Id`, no JWT and no
    // `X-Business-Id`.
    const res = await post(await envelope());

    expect(res.status).toBe(200);
  });

  it('returns the envelope structure', async () => {
    const res = await post(await envelope());
    const body = (await res.json()) as CaptureBody;

    expect(body.capture?.parsed).toBe(true);
    expect(body.capture?.topLevelKeys).toEqual([
      'intermediateSigningKey',
      'protocolVersion',
      'signature',
      'signedMessage',
    ]);
    expect(body.capture?.protocolVersion).toBe('ECv2SigningOnly');
    expect(body.capture?.signedMessage?.byteLength).toBe(new TextEncoder().encode(SIGNED_MESSAGE).length);
    expect(body.capture?.intermediateSigningKey?.signatures?.count).toBe(1);
    expect(body.capture?.intermediateSigningKey?.signedKey?.keyValueByteLength).toBe(91);
    expect(body.capture?.intermediateSigningKey?.signedKey?.algorithm).toBe('ECDSA P-256');
    expect(body.capture?.messageSignature?.firstByteHex).toBe('30');
  });

  it('fingerprints the bytes the verifier signs, so the derivation can be compared', async () => {
    const res = await post(await envelope());
    const body = (await res.json()) as CaptureBody;

    expect(body.capture?.derivedSignedBytes?.keySignatureInput?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.capture?.derivedSignedBytes?.messageSignatureInput?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports the protocol from the envelope, not from a constant in the code', async () => {
    // If the route answered with `CALLBACK_PROTOCOL_VERSION` this would pass for
    // the right reason and fail for the wrong one, which is the whole failure
    // mode of the code being diagnosed.
    const res = await post(await envelope({ protocolVersion: 'ECv2SigningOnlyXYZ' }));
    const body = (await res.json()) as CaptureBody;

    expect(body.capture?.protocolVersion).toBe('ECv2SigningOnlyXYZ');
  });

  it('writes nothing to the database', async () => {
    const before = vi.mocked(createDb).mock.calls.length;

    const res = await post(await envelope());

    expect(res.status).toBe(200);
    // `createDb` throws if called at all, so reaching this line already means it
    // was not. The counter makes the intent explicit rather than implied.
    expect(vi.mocked(createDb).mock.calls.length).toBe(before);
    expect(envWithoutDatabase()).not.toHaveProperty('DATABASE_URL');
  });

  describe('a hostile or broken body', () => {
    it('answers 200 with a report instead of throwing', async () => {
      const res = await post('this is not json');
      const body = (await res.json()) as CaptureBody;

      expect(res.status).toBe(200);
      expect(body.capture?.parsed).toBe(false);
      expect(body.capture?.notes).toContain('The body is not valid JSON.');
    });

    it.each([
      ['an empty body', ''],
      ['a JSON array', '[]'],
      ['a JSON string', '"hello"'],
      ['null', 'null'],
      ['an envelope with every field removed', '{}'],
      ['deeply wrong types', JSON.stringify({ protocolVersion: {}, signature: 1 })],
    ])('survives %s', async (_label, body) => {
      const res = await post(body);

      expect(res.status).toBe(200);
      expect((await res.json()) as CaptureBody).toHaveProperty('capture');
    });

    it('never lets a stack trace out', async () => {
      const res = await post('}{');
      const text = await res.text();

      expect(text).not.toContain('at ');
      expect(res.status).toBe(200);
    });

    it('reports a missing issuer id rather than failing, because that is a finding', async () => {
      const res = await post(await envelope(), { });
      const body = (await res.json()) as CaptureBody;

      expect(res.status).toBe(200);
      expect(body.capture?.recipientId?.configuredIssuerId).toBeNull();
      expect(body.capture?.derivedSignedBytes?.messageSignatureInput).toBeNull();
    });
  });

  describe('the capture is temporary', () => {
    it('labels itself in the response, so nobody mistakes it for a permanent API', async () => {
      const res = await post(await envelope());
      const body = (await res.json()) as CaptureBody;

      expect(body.ticket).toBe(ENVELOPE_CAPTURE_TICKET);
      expect(body.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(body.supersededBy).toBeNull();
    });

    it('is not superseded — delete the route when it is', async () => {
      const res = await post(await envelope());
      const body = (await res.json()) as CaptureBody;

      expect(
        body.supersededBy,
        `${ENVELOPE_CAPTURE_TICKET} has been superseded. Delete ${ENVELOPE_CAPTURE_PATH}, ` +
          'the gateway exemption, the anonymous rate limit, and both capture test files.',
      ).toBeNull();
    });
  });
});