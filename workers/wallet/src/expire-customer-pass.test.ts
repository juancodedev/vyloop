// The `vi.mock` factories below are hoisted above every import in this file, which
// is why the module under test is imported after them. Same shape as
// `reconcile-customer.test.ts`.

// ---------------------------------------------------------------------------
// Module-level mocks
//
// The same three seams `reconcile-customer.test.ts` replaces, and for the same
// reason: `expirePass` itself is **not** mocked, so every assertion below is about
// what the exported RPC does end to end — the read, the Google patch and the
// tracking write — rather than about a stub agreeing with itself.
// ---------------------------------------------------------------------------

vi.mock('./drizzle-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('./drizzle-store')>();
  return { ...original, createDrizzleWalletStore: vi.fn(), openTenantWalletStore: vi.fn() };
});

vi.mock('./helpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('./helpers')>();
  return { ...original, googleWalletClientFor: vi.fn() };
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { createDrizzleWalletStore, openTenantWalletStore } from './drizzle-store';
import { GoogleWalletApiError } from './google-client';
import type { GoogleWalletClient } from './google-client';
import { googleWalletClientFor } from './helpers';
import { classIdFor } from './ids';
import type { LoyaltyObject } from './object';
import type { PassExpiryUpdate, WalletPassRow, WalletProgramRow, WalletStore } from './store';

import defaultExport, { expireCustomerPass } from './index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = '3388000000023206930';
const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const CUSTOMER_ID = 'd185c973-c976-46b5-b3bf-06185739a941';
const OBJECT_ID = `${ISSUER}.member-c8b61954-1b6d-4dfa-9954-b7c936a9e648`;
const NOW = new Date('2026-10-27T12:00:00.000Z');

let env: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  env = {
    DATABASE_URL: 'postgres://mock',
    GOOGLE_WALLET_ISSUER_ID: ISSUER,
    GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: 'wallet@vyloop-demo.iam.gserviceaccount.com',
    GOOGLE_WALLET_PRIVATE_KEY: 'not-a-real-key',
    MEMBER_CODE_PEPPER: crypto.randomUUID(),
    WALLET_ALLOWED_ORIGINS: 'https://app.vyloop.app',
    WALLET_DEMO_MODE: 'false',
  };
});

function programRow(overrides: Partial<WalletProgramRow> = {}): WalletProgramRow {
  return {
    tenantId: TENANT,
    issuerId: ISSUER,
    classId: classIdFor(ISSUER, TENANT),
    reviewStatus: 'approved',
    demoMode: false,
    lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function passRow(overrides: Partial<WalletPassRow> = {}): WalletPassRow {
  return {
    customerId: CUSTOMER_ID,
    tenantId: TENANT,
    objectId: OBJECT_ID,
    state: 'issued',
    lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function savedObject(): LoyaltyObject {
  return {
    id: OBJECT_ID,
    classId: classIdFor(ISSUER, TENANT),
    state: 'ACTIVE',
    accountName: 'Ana Pérez',
    accountId: 'K7M2QX',
    loyaltyPoints: { label: 'puntos', balance: { string: '400' } },
    barcode: { type: 'QR_CODE', value: 'c8b61954-1b6d-4dfa-9954-b7c936a9e648' },
  };
}

// ---------------------------------------------------------------------------
// The store
//
// Only the three methods the expiry path is allowed to reach are real. Every
// other method throws, so an expiry that grew a dependency on a read filtered by
// `deleted_at IS NULL` — `findCustomer`, `findCustomerById`, or the balance
// path's `findPass` — fails loudly here instead of silently finding nothing for a
// customer who is, by construction, already deleted.
// ---------------------------------------------------------------------------

interface FakeStore {
  store: WalletStore;
  findProgram: Mock;
  findDeletedCustomerPass: Mock;
  recordPassExpired: Mock;
  /** The row as the store holds it, mutated by `recordPassExpired`. */
  row: () => WalletPassRow | null;
}

function fakeStore(overrides: { program?: WalletProgramRow | null; pass?: WalletPassRow | null } = {}): FakeStore {
  let row = overrides.pass === undefined ? passRow() : overrides.pass;

  const findProgram = vi.fn(async () => (overrides.program === undefined ? programRow() : overrides.program));
  const findDeletedCustomerPass = vi.fn(async (customerId: string, tenantId: string) => {
    if (row === null) return null;
    if (row.customerId !== customerId || row.tenantId !== tenantId) return null;
    return { ...row };
  });
  // The SQL predicate, modelled: only a row asserting a saved object moves.
  const recordPassExpired = vi.fn(async (update: PassExpiryUpdate) => {
    if (row === null) return 0;
    if (row.customerId !== update.customerId || row.tenantId !== update.tenantId) return 0;
    if (!['issued', 'inactive', 'completed'].includes(row.state)) return 0;
    row = { ...row, state: 'expired', lastSyncedAt: update.observedAt };
    return 1;
  });

  const unused = (name: string) =>
    vi.fn(async (): Promise<never> => {
      throw new Error(`${name} is not part of the expiry path and was not expected to be called`);
    });

  const store = {
    findProgram,
    findDeletedCustomerPass,
    recordPassExpired,
    findPass: unused('findPass'),
    findCustomer: unused('findCustomer'),
    findCustomerById: unused('findCustomerById'),
    latestBalance: unused('latestBalance'),
    recordPassReconciliation: unused('recordPassReconciliation'),
    recordPassLifecycle: unused('recordPassLifecycle'),
    recordPassObservation: unused('recordPassObservation'),
    recordPass: unused('recordPass'),
  } as unknown as WalletStore;

  return { store, findProgram, findDeletedCustomerPass, recordPassExpired, row: () => row };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

type FakeClient = GoogleWalletClient & { getObject: Mock; patchObject: Mock };

/**
 * A Google holding one object, or failing the patch with `failWith`.
 *
 * The patch is applied the way Google's patch semantics apply it: a field sent
 * as `null` is cleared, a field sent with a value replaces it, and a field not
 * sent is left alone. A fake that merged blindly would echo `accountName: null`
 * back and make the post-condition pass for the wrong reason.
 */
function fakeClient(options: { failWith?: Error } = {}): FakeClient {
  let current: LoyaltyObject = savedObject();

  const notUsed = (name: string) =>
    vi.fn(async () => {
      throw new Error(`${name} is not part of the expiry path`);
    });

  return {
    getClass: notUsed('getClass'),
    insertClass: notUsed('insertClass'),
    patchClass: notUsed('patchClass'),
    getObject: notUsed('getObject'),
    insertObject: notUsed('insertObject'),
    listObjects: notUsed('listObjects'),
    saveUriForJwt: notUsed('saveUriForJwt'),
    addMessage: notUsed('addMessage'),
    patchObject: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      if (options.failWith) throw options.failWith;
      const next: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      current = next as unknown as LoyaltyObject;
      return current;
    }),
  } as unknown as FakeClient;
}

function install(store: FakeStore, client: FakeClient) {
  vi.mocked(createDrizzleWalletStore).mockReturnValue(store.store);
  vi.mocked(openTenantWalletStore).mockReturnValue(store.store);
  vi.mocked(googleWalletClientFor).mockReturnValue(client);

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);

  return expireCustomerPass({ tenantId: TENANT, customerId: CUSTOMER_ID }, env as never);
}

function googleError(status: number): GoogleWalletApiError {
  return new GoogleWalletApiError(status, status === 404 ? 'notFound' : 'backendError', [
    { message: 'Google said no', reason: null, location: null },
  ]);
}

// ============================================================================
// The rules
// ============================================================================

describe('expireCustomerPass', () => {
  it('expires a saved pass at Google without the name, and records it expired', async () => {
    const store = fakeStore();
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(outcome).toEqual({ kind: 'expired', objectId: OBJECT_ID, recorded: true });
    // The exact payload: the state, and the name cleared with an explicit null.
    // Nothing else, so the balance, the member code and the barcode are not
    // rewritten by a path that has no business deciding them.
    expect(client.patchObject).toHaveBeenCalledTimes(1);
    expect(client.patchObject).toHaveBeenCalledWith(OBJECT_ID, { state: 'EXPIRED', accountName: null });
    expect(store.recordPassExpired).toHaveBeenCalledWith({
      customerId: CUSTOMER_ID,
      tenantId: TENANT,
      observedAt: NOW,
    });
    expect(store.row()).toMatchObject({ state: 'expired', lastSyncedAt: NOW });
    // The tenant session is opened for the caller's tenant, like every other RPC.
    expect(openTenantWalletStore).toHaveBeenCalledWith('postgres://mock', TENANT);
  });

  it('asks Google nothing and records nothing when the customer has no pass row', async () => {
    const store = fakeStore({ pass: null });
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(outcome).toEqual({ kind: 'nothing_to_expire', reason: 'no_tracking_row' });
    expect(client.patchObject).not.toHaveBeenCalled();
    expect(store.recordPassExpired).not.toHaveBeenCalled();
    expect(store.row()).toBeNull();
  });

  it.each(['not_issued', 'not_saved'])(
    'asks Google nothing and records nothing for a pass that was never saved (%s)',
    async (state) => {
      const store = fakeStore({ pass: passRow({ state }) });
      const client = fakeClient();

      const outcome = await install(store, client);

      expect(outcome).toEqual({ kind: 'nothing_to_expire', reason: 'never_saved' });
      expect(client.patchObject).not.toHaveBeenCalled();
      expect(store.recordPassExpired).not.toHaveBeenCalled();
      expect(store.row()?.state).toBe(state);
    },
  );

  it('records the pass expired when Google answers 404, because the object is gone', async () => {
    const store = fakeStore();
    const client = fakeClient({ failWith: googleError(404) });

    const outcome = await install(store, client);

    expect(outcome).toEqual({ kind: 'already_gone', objectId: OBJECT_ID, recorded: true });
    expect(client.patchObject).toHaveBeenCalledWith(OBJECT_ID, { state: 'EXPIRED', accountName: null });
    expect(store.row()).toMatchObject({ state: 'expired', lastSyncedAt: NOW });
  });

  it('leaves the row as it was and reports a failure when Google answers 500', async () => {
    const store = fakeStore();
    const client = fakeClient({ failWith: googleError(500) });

    const outcome = await install(store, client);

    expect(outcome).toEqual({
      kind: 'failed',
      objectId: OBJECT_ID,
      reason: expect.stringContaining('500') as unknown as string,
    });
    expect(client.patchObject).toHaveBeenCalledTimes(1);
    expect(store.recordPassExpired).not.toHaveBeenCalled();
    expect(store.row()).toEqual(passRow());
  });

  it('asks Google nothing for a pass already recorded expired, so a retry is idempotent', async () => {
    const store = fakeStore({ pass: passRow({ state: 'expired' }) });
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(outcome).toEqual({ kind: 'already_expired', objectId: OBJECT_ID });
    expect(client.patchObject).not.toHaveBeenCalled();
    expect(store.recordPassExpired).not.toHaveBeenCalled();
    expect(store.row()?.state).toBe('expired');
  });

  it('asks Google nothing when the class cannot back a pass, mirroring reconcilePass', async () => {
    const store = fakeStore({ program: programRow({ reviewStatus: 'draft' }) });
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'class_not_approved' });
    expect(client.patchObject).not.toHaveBeenCalled();
    expect(store.recordPassExpired).not.toHaveBeenCalled();
  });

  it('turns a thrown database error into a failure outcome rather than rejecting', async () => {
    // The caller runs this under `waitUntil` across a service binding, where a
    // rejection is a stack trace attached to a request that already answered 204.
    const store = fakeStore();
    store.findDeletedCustomerPass.mockRejectedValueOnce(new Error('connection reset'));
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(outcome).toEqual({ kind: 'failed', objectId: null, reason: 'connection reset' });
    expect(client.patchObject).not.toHaveBeenCalled();
  });
});

describe('the RPC surface', () => {
  it('exposes expireCustomerPass on the default object beside the existing reconcileCustomer', () => {
    // The regression half: adding the expiry must not displace the push trigger
    // growth already calls through the same default export.
    const exported = defaultExport as unknown as Record<string, unknown>;
    expect(exported.expireCustomerPass).toBe(expireCustomerPass);
    expect(typeof exported.reconcileCustomer).toBe('function');
    expect(typeof exported.scheduled).toBe('function');
  });
});
