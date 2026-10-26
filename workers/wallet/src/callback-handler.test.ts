/**
 * Tests for the callback rules, over an in-memory `WalletStore`.
 *
 * ## The signatures here are real
 *
 * `signCallback` builds a genuine `ECv2SigningOnly` envelope with keys generated
 * in the test, so "the store was not called" is a statement about this code and
 * not about a stubbed crypto layer. A test that handed the handler a
 * pre-verified event would pass unchanged after someone deleted the call to
 * `verifyPassCallback`.
 *
 * ## What the store records, and why
 *
 * `FakeStore` keeps a `calls` log. The central assertions read it rather than
 * only inspecting state, because for several of these tests the interesting
 * claim is not "the row says X" but "**nothing was touched at all**" — and a
 * state assertion passes just as happily when the wrong write happened to leave
 * the state unchanged.
 */

import { describe, expect, it } from 'vitest';

import { handlePassCallback } from './callback-handler';
import type { CallbackDeps } from './callback-handler';
import {
  CALLBACK_PROTOCOL_VERSION,
  CALLBACK_SENDER_ID,
  decodeRootKeys,
} from './callbacks';
import type { WalletStore } from './store';

// ---------------------------------------------------------------------------
// A minimal store
// ---------------------------------------------------------------------------

interface PassRow {
  customerId: string;
  tenantId: string;
  objectId: string;
  state: string;
  lastSyncedAt: Date | null;
}

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const ISSUER = '3388000000023206930';
const CLASS_A = `${ISSUER}.tenant-${TENANT_A}`;
const CLASS_B = `${ISSUER}.tenant-${TENANT_B}`;

class FakeStore implements WalletStore {
  async getIssuerId(): Promise<string> {
    throw new Error('getIssuerId is not used by the callback path');
  }

  /** Every method call, in order. The "nothing happened" assertions read this. */
  readonly calls: string[] = [];

  readonly passes = new Map<string, PassRow>();
  /** class_id → tenant_id. */
  readonly classOwners = new Map<string, string>();
  /** `${tenantId}|${nonce}` for every claimed delivery. */
  readonly claimed = new Set<string>();

  constructor(rows: PassRow[] = []) {
    for (const row of rows) this.passes.set(`${row.tenantId}|${row.objectId}`, row);
  }

  async findTenantByClassId(classId: string): Promise<{ tenantId: string } | null> {
    this.calls.push('findTenantByClassId');
    const tenantId = this.classOwners.get(classId);
    return tenantId === undefined ? null : { tenantId };
  }

  async claimCallbackDelivery(claim: { tenantId: string; nonce: string }): Promise<boolean> {
    this.calls.push('claimCallbackDelivery');
    const key = `${claim.tenantId}|${claim.nonce}`;
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  async findPassesByObjectIds(objectIds: string[], tenantId: string): Promise<PassRow[]> {
    this.calls.push('findPassesByObjectIds');
    return objectIds
      .map((id) => this.passes.get(`${tenantId}|${id}`))
      .filter((row): row is PassRow => row !== undefined);
  }

  /**
   * The pass-inactivity rule's query. Unreachable from this suite: the rule has its
   * own module and its own fake store, and a fake that quietly answered it would
   * let a caller reach it without any test noticing.
   */
  async findInactivePassCandidates(): Promise<never> {
    throw new Error('findInactivePassCandidates is not used by this test suite.');
  }

  /**
   * The nearby-locations fan-out. Unreachable from this suite for the same
   * reason as the query above.
   */
  async listConsentingPasses(): Promise<never> {
    throw new Error('listConsentingPasses is not used by this test suite.');
  }

  async recordPassCallback(
    update: { customerId: string; tenantId: string } & { eventType: 'save' | 'del' },
    observedAt: Date,
  ): Promise<number> {
    this.calls.push('recordPassCallback');
    const row = [...this.passes.values()].find(
      (candidate) =>
        candidate.customerId === update.customerId && candidate.tenantId === update.tenantId,
    );
    if (row === undefined) return 0;
    // Mirrors the SQL predicate: the terminal lifecycle states are terminal.
    if (row.state === 'expired' || row.state === 'completed') return 0;

    row.state = update.eventType === 'save' ? 'issued' : 'not_saved';
    row.lastSyncedAt = observedAt;
    return 1;
  }

  // -- Unused surface -------------------------------------------------------
  // Present to satisfy the interface. Each throws, so a callback path that
  // reached one fails loudly instead of silently passing a test.
  async findCustomer(): Promise<null> {
    throw new Error('not used by the callback path');
  }
  async findCustomerById(): Promise<null> {
    throw new Error('not used by the callback path');
  }
  async findProgram(): Promise<null> {
    throw new Error('not used by the callback path');
  }
  async insertProgram(): Promise<void> {
    throw new Error('not used by the callback path');
  }
  async findTenantBranding(): Promise<null> {
    throw new Error('not used by the callback path');
  }

  /**
   * Throws, like the other off-path reads here.
   *
   * A Google callback carries a `classId` and resolves the tenant from it; that is
   * the deliberate cross-tenant read of this worker. It has no operator console
   * attached to it and therefore no reason to learn a merchant's display name or
   * slug, and a callback path that did would be resolving identity from something
   * that is not the signed request.
   */
  async findProgramWithBusiness(): Promise<null> {
    throw new Error('not used by the callback path');
  }
  async findProgramName(): Promise<string | null> {
    throw new Error('not used by the callback path');
  }
  async findPointsCurrency(): Promise<string | null> {
    throw new Error('not used by the callback path');
  }
  async findPromoCopy(): Promise<string | null> {
    throw new Error('not used by the callback path');
  }
  async findTierName(): Promise<null> {
    throw new Error('not used by the callback path');
  }
  async latestBalance(): Promise<number> {
    throw new Error('not used by the callback path');
  }
  async isMemberCodeTaken(): Promise<boolean> {
    throw new Error('not used by the callback path');
  }
  async claimMemberCode(): Promise<string | null> {
    throw new Error('not used by the callback path');
  }
  async recordPass(): Promise<void> {
    throw new Error('not used by the callback path');
  }
  async findPass(): Promise<null> {
    throw new Error('not used by the callback path');
  }
  async recordPassReconciliation(): Promise<number> {
    throw new Error('not used by the callback path');
  }
  async recordPassLifecycle(): Promise<number> {
    throw new Error('not used by the callback path');
  }
  async recordPassObservation(): Promise<number> {
    throw new Error('not used by the callback path');
  }
  async listProgramTenants(): Promise<never[]> {
    throw new Error('not used by the callback path');
  }
  async listTenantsWithoutProgram(): Promise<string[]> {
    throw new Error('not used by the callback path');
  }
  async updateProgramReviewStatus(): Promise<void> {
    throw new Error('not used by the callback path');
  }
  async setProgramDemoMode(): Promise<number> {
    throw new Error('not used by the callback path');
  }
}

// ---------------------------------------------------------------------------
// Signed envelopes
// ---------------------------------------------------------------------------

/**
 * The protocol's length-prefixed concatenation: four bytes of UTF-8 byte length,
 * little-endian, per part. Restated from Google's specification rather than
 * imported, and via `DataView` rather than shifts, so it is not a copy of the
 * code it exercises. See `callbacks.signed-bytes.test.ts` for pinned vectors.
 */
function toLengthValue(parts: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoded = parts.map((part) => new TextEncoder().encode(part));
  const total = encoded.reduce((sum, bytes) => sum + 4 + bytes.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.length, true);
    out.set(bytes, offset + 4);
    offset += 4 + bytes.length;
  }
  return out;
}

function p1363ToDer(p1363: Uint8Array): Uint8Array {
  const encodeInteger = (value: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0x00) start += 1;
    const magnitude = value.subarray(start);
    const needsSign = (magnitude[0] & 0x80) !== 0;
    const out = new Uint8Array(2 + magnitude.length + (needsSign ? 1 : 0));
    out[0] = 0x02;
    out[1] = magnitude.length + (needsSign ? 1 : 0);
    if (needsSign) {
      out[2] = 0x00;
      out.set(magnitude, 3);
    } else {
      out.set(magnitude, 2);
    }
    return out;
  };

  const r = encodeInteger(p1363.subarray(0, 32));
  const s = encodeInteger(p1363.subarray(32, 64));
  const out = new Uint8Array(2 + r.length + s.length);
  out[0] = 0x30;
  out[1] = r.length + s.length;
  out.set(r, 2);
  out.set(s, 2 + r.length);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function makeKey(): Promise<{ privateKey: CryptoKey; spki: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return {
    privateKey: pair.privateKey,
    spki: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
  };
}

async function sign(key: CryptoKey, parts: readonly string[]): Promise<string> {
  const raw = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, toLengthValue(parts));
  return bytesToBase64(p1363ToDer(new Uint8Array(raw)));
}

const NOW = new Date('2029-06-01T00:00:00Z');
const FUTURE = Date.parse('2035-01-01T00:00:00Z');

interface Chain {
  root: { privateKey: CryptoKey; spki: string };
  intermediate: { privateKey: CryptoKey; spki: string };
}

async function makeChain(): Promise<Chain> {
  return { root: await makeKey(), intermediate: await makeKey() };
}

interface SignOptions {
  classId?: string;
  objectId?: string;
  eventType?: string;
  nonce?: string;
  expTimeMillis?: number;
  /** Sign with a root key the verifier is not told about. */
  withUntrustedRoot?: boolean;
}

async function signCallback(chain: Chain, options: SignOptions = {}): Promise<string> {
  const signedMessage = JSON.stringify({
    classId: options.classId ?? CLASS_A,
    objectId: options.objectId ?? `${ISSUER}.member-cust-1`,
    eventType: options.eventType ?? 'save',
    expTimeMillis: options.expTimeMillis ?? FUTURE,
    nonce: options.nonce ?? 'nonce-1',
  });

  const signedKey = JSON.stringify({ keyValue: chain.intermediate.spki, keyExpiration: '99999999999999' });

  return JSON.stringify({
    protocolVersion: CALLBACK_PROTOCOL_VERSION,
    signature: await sign(chain.intermediate.privateKey, [
      CALLBACK_SENDER_ID,
      ISSUER,
      CALLBACK_PROTOCOL_VERSION,
      signedMessage,
    ]),
    intermediateSigningKey: {
      signedKey,
      signatures: [
        await sign(chain.root.privateKey, [
          CALLBACK_SENDER_ID,
          CALLBACK_PROTOCOL_VERSION,
          signedKey,
        ]),
      ],
    },
    signedMessage,
  });
}

function depsFor(store: WalletStore, chain: Chain): CallbackDeps {
  return {
    store,
    recipientId: ISSUER,
    now: () => NOW,
    fetchRootKeys: async () =>
      decodeRootKeys(
        JSON.stringify({
          keys: [
            { keyValue: chain.root.spki, protocolVersion: CALLBACK_PROTOCOL_VERSION, keyExpiration: '99999999999999' },
          ],
        }),
        NOW.getTime(),
      ),
  };
}

/** A store with one saved pass in tenant A. */
function storeWithPass(state = 'not_issued'): FakeStore {
  const store = new FakeStore([
    {
      customerId: 'cust-1',
      tenantId: TENANT_A,
      objectId: `${ISSUER}.member-cust-1`,
      state,
      lastSyncedAt: null,
    },
  ]);
  store.classOwners.set(CLASS_A, TENANT_A);
  return store;
}

// ---------------------------------------------------------------------------

describe('handlePassCallback', () => {
  describe('an unsigned or forged request', () => {
    it('writes nothing at all and reports a rejection', async () => {
      // The single most important property of this endpoint. A request that
      // cannot prove it came from Google must not move a row, and must not so
      // much as *look* at the database.
      const store = storeWithPass();
      const chain = await makeChain();

      const outcome = await handlePassCallback(
        depsFor(store, chain),
        JSON.stringify({ hello: 'world' }),
      );

      expect(outcome).toEqual({ kind: 'rejected', code: 'malformed_envelope' });
      expect(store.calls).toEqual([]);
      expect(store.passes.get(`${TENANT_A}|${ISSUER}.member-cust-1`)?.state).toBe('not_issued');
    });

    it('refuses a well-formed body signed by a key Google does not vouch for', async () => {
      const store = storeWithPass();
      const trusted = await makeChain();
      const attacker = await makeChain();

      const outcome = await handlePassCallback(
        depsFor(store, trusted),
        await signCallback(attacker, { objectId: `${ISSUER}.member-cust-1` }),
      );

      expect(outcome).toEqual({ kind: 'rejected', code: 'intermediate_key_unverified' });
      expect(store.calls).toEqual([]);
    });

    it('refuses a replayed message body whose signature no longer covers it', async () => {
      const store = storeWithPass();
      const chain = await makeChain();

      const body = JSON.parse(await signCallback(chain)) as Record<string, unknown>;
      const signed = JSON.parse(body.signedMessage as string) as Record<string, unknown>;
      // Same signature, different object: the attack the length-prefix scheme
      // and the message check exist to stop.
      signed.objectId = `${ISSUER}.member-someone-else`;
      body.signedMessage = JSON.stringify(signed);

      const outcome = await handlePassCallback(depsFor(store, chain), JSON.stringify(body));

      expect(outcome).toEqual({ kind: 'rejected', code: 'message_unverified' });
      expect(store.calls).toEqual([]);
    });

    it('refuses a body that is not JSON, without throwing', async () => {
      // A malformed body must be a controlled refusal, not a 500 with a stack.
      // A 500 is the one answer that makes Google retry a message which can
      // never become valid.
      const store = storeWithPass();
      const chain = await makeChain();

      const outcome = await handlePassCallback(depsFor(store, chain), '}{ not json');

      expect(outcome).toEqual({ kind: 'rejected', code: 'malformed_envelope' });
      expect(store.calls).toEqual([]);
    });
  });

  describe('idempotency by nonce', () => {
    it('applies a save once and does nothing for the same nonce again', async () => {
      // Google retries. A repeated SAVE must not duplicate the effect, and must
      // not even re-enter the write path.
      const store = storeWithPass();
      const chain = await makeChain();
      const body = await signCallback(chain, { nonce: 'same-nonce' });

      const first = await handlePassCallback(depsFor(store, chain), body);
      expect(first).toEqual({ kind: 'applied', eventType: 'save', state: 'issued' });

      store.calls.length = 0;
      const second = await handlePassCallback(depsFor(store, chain), body);

      expect(second).toEqual({ kind: 'skipped', reason: 'replay' });
      // The tenant is still resolved first — the nonce is scoped per tenant, so
      // the claim cannot be attempted without it. What the replay must not do is
      // reach the pass lookup or the write.
      expect(store.calls).toEqual(['findTenantByClassId', 'claimCallbackDelivery']);
      expect(store.passes.get(`${TENANT_A}|${ISSUER}.member-cust-1`)?.state).toBe('issued');
    });

    it('does not let a replayed save resurrect a pass a real delete removed', async () => {
      // The corruption nonce-deduplication exists to prevent, and the reason
      // state idempotency alone is not enough: the two deliveries are genuinely
      // different events, so both look legitimate to a state machine.
      const store = storeWithPass();
      const chain = await makeChain();

      const save = await signCallback(chain, { nonce: 'n-save', eventType: 'save' });
      const del = await signCallback(chain, { nonce: 'n-del', eventType: 'del' });

      await handlePassCallback(depsFor(store, chain), save);
      expect(store.passes.get(`${TENANT_A}|${ISSUER}.member-cust-1`)?.state).toBe('issued');

      await handlePassCallback(depsFor(store, chain), del);
      expect(store.passes.get(`${TENANT_A}|${ISSUER}.member-cust-1`)?.state).toBe('not_saved');

      // Google retries the original save, minutes late. Without the nonce it
      // would report to a merchant that a customer is holding a deleted pass.
      const replayed = await handlePassCallback(depsFor(store, chain), save);
      expect(replayed).toEqual({ kind: 'skipped', reason: 'replay' });
      expect(store.passes.get(`${TENANT_A}|${ISSUER}.member-cust-1`)?.state).toBe('not_saved');
    });

    it('claims the nonce before writing, never after', async () => {
      // Ordering is the contract. A handler that wrote first and recorded
      // afterwards would be audited, not idempotent, and a retry landing in the
      // gap would apply twice.
      const store = storeWithPass();
      const chain = await makeChain();

      await handlePassCallback(
        depsFor(store, chain),
        await signCallback(chain, { nonce: 'ordering' }),
      );

      const writeIndex = store.calls.indexOf('recordPassCallback');
      const claimIndex = store.calls.indexOf('claimCallbackDelivery');
      expect(claimIndex).toBeGreaterThanOrEqual(0);
      expect(writeIndex).toBeGreaterThan(claimIndex);
    });
  });

  describe('tenant isolation', () => {
    it('refuses to touch a row in another tenant when the class belongs elsewhere', async () => {
      // The security property. Tenant B's pass has the *same* objectId; only the
      // class in the body differs, and the class is the only thing that can name
      // a tenant.
      const store = new FakeStore([
        {
          customerId: 'cust-b',
          tenantId: TENANT_B,
          objectId: `${ISSUER}.member-shared-id`,
          state: 'issued',
          lastSyncedAt: null,
        },
      ]);
      store.classOwners.set(CLASS_A, TENANT_A);
      const chain = await makeChain();

      const outcome = await handlePassCallback(
        depsFor(store, chain),
        await signCallback(chain, {
          classId: CLASS_A,
          objectId: `${ISSUER}.member-shared-id`,
          eventType: 'del',
        }),
      );

      // Tenant A is resolved, and tenant A has no pass with that object id, so
      // the write is scoped to nothing.
      expect(outcome).toEqual({ kind: 'skipped', reason: 'no_pass_row' });
      expect(store.passes.get(`${TENANT_B}|${ISSUER}.member-shared-id`)?.state).toBe('issued');
      expect(store.calls).not.toContain('recordPassCallback');
    });

    it('refuses a class this deployment has no row for', async () => {
      const store = storeWithPass();
      const chain = await makeChain();

      const outcome = await handlePassCallback(
        depsFor(store, chain),
        await signCallback(chain, { classId: `${ISSUER}.tenant-unknown` }),
      );

      expect(outcome).toEqual({ kind: 'skipped', reason: 'unknown_class' });
      expect(store.calls).toEqual(['findTenantByClassId']);
    });

    it('scopes the nonce per tenant, so one merchant cannot suppress another', async () => {
      // The unique index is on (tenant_id, nonce). Two tenants' callbacks
      // arriving with the same nonce string are two events.
      const store = new FakeStore([
        { customerId: 'c-a', tenantId: TENANT_A, objectId: `${ISSUER}.member-a`, state: 'not_saved', lastSyncedAt: null },
        { customerId: 'c-b', tenantId: TENANT_B, objectId: `${ISSUER}.member-b`, state: 'not_saved', lastSyncedAt: null },
      ]);
      store.classOwners.set(CLASS_A, TENANT_A);
      store.classOwners.set(CLASS_B, TENANT_B);
      const chain = await makeChain();

      const first = await handlePassCallback(
        depsFor(store, chain),
        await signCallback(chain, { classId: CLASS_A, objectId: `${ISSUER}.member-a`, nonce: 'shared' }),
      );
      const second = await handlePassCallback(
        depsFor(store, chain),
        await signCallback(chain, { classId: CLASS_B, objectId: `${ISSUER}.member-b`, nonce: 'shared' }),
      );

      expect(first).toMatchObject({ kind: 'applied' });
      expect(second).toMatchObject({ kind: 'applied' });
    });
  });

  describe('the state each event writes', () => {
    it('writes issued for a save, because the pass is in the phone', async () => {
      const store = storeWithPass('not_saved');
      const chain = await makeChain();

      const outcome = await handlePassCallback(
        depsFor(store, chain),
        await signCallback(chain, { eventType: 'save' }),
      );

      expect(outcome).toEqual({ kind: 'applied', eventType: 'save', state: 'issued' });
      expect(store.passes.get(`${TENANT_A}|${ISSUER}.member-cust-1`)?.state).toBe('issued');
    });

    it('writes not_saved for a del, and does so from issued', async () => {
      // The transition the existence guard would have refused, and the one the
      // whole feature exists to record.
      const store = storeWithPass('issued');
      const chain = await makeChain();

      const outcome = await handlePassCallback(
        depsFor(store, chain),
        await signCallback(chain, { eventType: 'del' }),
      );

      expect(outcome).toEqual({ kind: 'applied', eventType: 'del', state: 'not_saved' });
      expect(store.passes.get(`${TENANT_A}|${ISSUER}.member-cust-1`)?.state).toBe('not_saved');
    });

    it('stamps last_synced_at, because the answer was definitive', async () => {
      const store = storeWithPass();
      const chain = await makeChain();

      await handlePassCallback(
        depsFor(store, chain),
        await signCallback(chain, { eventType: 'save' }),
      );

      expect(store.passes.get(`${TENANT_A}|${ISSUER}.member-cust-1`)?.lastSyncedAt).toEqual(NOW);
    });

    it('refuses an event type it has no tracking state for', async () => {
      const store = storeWithPass();
      const chain = await makeChain();

      const outcome = await handlePassCallback(
        depsFor(store, chain),
        await signCallback(chain, { eventType: 'REFRESH' }),
      );

      expect(outcome).toEqual({ kind: 'rejected', code: 'unsupported_event_type' });
      expect(store.calls).toEqual([]);
    });
  });

  describe('when there is nothing to update', () => {
    it('reports a pass row it cannot find, without claiming success', async () => {
      const store = storeWithPass();
      const chain = await makeChain();

      const outcome = await handlePassCallback(
        depsFor(store, chain),
        await signCallback(chain, { objectId: `${ISSUER}.member-never-issued` }),
      );

      expect(outcome).toEqual({ kind: 'skipped', reason: 'no_pass_row' });
    });

    it('reports a refused state write rather than a success it did not perform', async () => {
      // An expired pass is terminal. A save arriving late must not resurrect it,
      // and the outcome must not claim a write that matched nothing.
      const store = storeWithPass('expired');
      const chain = await makeChain();

      const outcome = await handlePassCallback(
        depsFor(store, chain),
        await signCallback(chain, { eventType: 'save' }),
      );

      expect(outcome).toEqual({ kind: 'skipped', reason: 'state_write_refused' });
      expect(store.passes.get(`${TENANT_A}|${ISSUER}.member-cust-1`)?.state).toBe('expired');
    });
  });

  describe('the outcome carries no identifier', () => {
    it('never puts an objectId, classId or nonce in the result', async () => {
      // `objectId` embeds `customers.global_id`, and the route logs outcomes.
      // Keeping the identifiers out of the type is what stops a later edit from
      // adding one to a log line.
      const store = storeWithPass();
      const chain = await makeChain();

      const applied = await handlePassCallback(
        depsFor(store, chain),
        await signCallback(chain, { nonce: 'secret-nonce' }),
      );
      const rejected = await handlePassCallback(depsFor(store, chain), 'garbage');

      for (const outcome of [applied, rejected]) {
        expect(Object.keys(outcome).sort()).not.toContain('objectId');
        expect(Object.keys(outcome).sort()).not.toContain('classId');
        expect(Object.keys(outcome).sort()).not.toContain('nonce');
        expect(JSON.stringify(outcome)).not.toContain('secret-nonce');
        expect(JSON.stringify(outcome)).not.toContain('member-cust-1');
      }
    });
  });
});
