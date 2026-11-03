// The `vi.mock` factories below are hoisted above every import in this file, which
// is why the module under test is imported after them. Same shape as
// `expire-customer-pass.test.ts`: the two seams that reach the network are
// replaced, and the rotation itself runs for real through the default export.

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

import { deriveCardToken, hashCardToken, isCardToken } from './card-token';
import { openTenantWalletStore } from './drizzle-store';
import { GoogleWalletApiError } from './google-client';
import type { GoogleWalletClient } from './google-client';
import { googleWalletClientFor } from './helpers';
import { classIdFor } from './ids';
import type { LoyaltyObject } from './object';
import type {
  CardTokenRotationWrite,
  WalletCustomerRow,
  WalletPassRow,
  WalletProgramRow,
  WalletStore,
} from './store';

import defaultExport, { rotateCardToken } from './index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = '3388000000023206930';
const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const CUSTOMER_ID = 'd185c973-c976-46b5-b3bf-06185739a941';
const GLOBAL_ID = 'c8b61954-1b6d-4dfa-9954-b7c936a9e648';
const OBJECT_ID = `${ISSUER}.member-${GLOBAL_ID}`;
const ACTOR = '11111111-2222-3333-4444-555555555555';
const REASON = 'Customer reported a leaked screenshot';
const MEMBER_CODE = 'K7M2QX';
/** Generated for this run and discarded with it. Never a real secret. */
const SECRET = crypto.randomUUID() + crypto.randomUUID();

let env: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  env = {
    DATABASE_URL: 'postgres://mock',
    GOOGLE_WALLET_ISSUER_ID: ISSUER,
    GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: 'wallet@vyloop-demo.iam.gserviceaccount.com',
    GOOGLE_WALLET_PRIVATE_KEY: 'not-a-real-key',
    MEMBER_CODE_PEPPER: crypto.randomUUID(),
    CARD_TOKEN_SECRET: SECRET,
    WALLET_ALLOWED_ORIGINS: 'https://app.vyloop.app',
    WALLET_DEMO_MODE: 'false',
  };
});

function tokenFor(version: number): Promise<string> {
  return deriveCardToken({ secret: SECRET, tenantId: TENANT, customerGlobalId: GLOBAL_ID, version });
}

function customerRow(overrides: Partial<WalletCustomerRow> = {}): WalletCustomerRow {
  return {
    id: CUSTOMER_ID,
    globalId: GLOBAL_ID,
    fullName: 'Ana Pérez',
    memberCode: MEMBER_CODE,
    currentTierId: 'tier-gold',
    cardTokenVersion: null,
    cardTokenHash: null,
    ...overrides,
  };
}

function programRow(): WalletProgramRow {
  return {
    tenantId: TENANT,
    issuerId: ISSUER,
    classId: classIdFor(ISSUER, TENANT),
    reviewStatus: 'approved',
    demoMode: false,
    lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
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

/** What Google holds before the rotation: a legacy pass with the uuid barcode. */
function savedObject(barcodeValue = GLOBAL_ID): LoyaltyObject {
  return {
    id: OBJECT_ID,
    classId: classIdFor(ISSUER, TENANT),
    state: 'ACTIVE',
    accountName: 'Ana Pérez',
    accountId: MEMBER_CODE,
    loyaltyPoints: { label: 'puntos', balance: { string: '400' } },
    barcode: { type: 'QR_CODE', value: barcodeValue },
  };
}

// ---------------------------------------------------------------------------
// The store
//
// The four methods the rotation may reach are real. Every other method throws,
// so a rotation that grew a write to the ledger, the tier, the member code or the
// pass row fails here (S9) rather than silently doing it.
// ---------------------------------------------------------------------------

interface FakeStore {
  store: WalletStore;
  rotations: CardTokenRotationWrite[];
  customer: () => WalletCustomerRow | null;
  pass: () => WalletPassRow | null;
  rotateCardToken: Mock;
}

function fakeStore(
  overrides: { customer?: WalletCustomerRow | null; pass?: WalletPassRow | null; raceOnce?: boolean } = {},
): FakeStore {
  let customer = overrides.customer === undefined ? customerRow() : overrides.customer;
  const pass = overrides.pass === undefined ? passRow() : overrides.pass;
  const rotations: CardTokenRotationWrite[] = [];
  let raced = false;

  const rotateCardToken = vi.fn(async (write: CardTokenRotationWrite) => {
    if (customer === null) return false;
    if (write.customerId !== customer.id || write.tenantId !== TENANT) return false;
    if (overrides.raceOnce === true && !raced) {
      // Another rotation lands between this one's read and its write.
      raced = true;
      const moved = (customer.cardTokenVersion ?? 0) + 1;
      customer = { ...customer, cardTokenVersion: moved, cardTokenHash: await hashCardToken(await tokenFor(moved)) };
      return false;
    }
    // The compare-and-set, modelled.
    if ((customer.cardTokenVersion ?? null) !== write.expectedVersion) return false;
    rotations.push(write);
    customer = { ...customer, cardTokenVersion: write.newVersion, cardTokenHash: write.newHash };
    return true;
  });

  const unused = (name: string) =>
    vi.fn(async (): Promise<never> => {
      throw new Error(`${name} is not part of the rotation path and was not expected to be called`);
    });

  const store = {
    findCustomerById: vi.fn(async (customerId: string, tenantId: string) =>
      customer !== null && customer.id === customerId && tenantId === TENANT ? { ...customer } : null,
    ),
    findPass: vi.fn(async (customerId: string, tenantId: string) =>
      pass !== null && pass.customerId === customerId && pass.tenantId === tenantId ? { ...pass } : null,
    ),
    findProgram: vi.fn(async (tenantId: string) => (tenantId === TENANT ? programRow() : null)),
    rotateCardToken,
    findCustomer: unused('findCustomer'),
    latestBalance: unused('latestBalance'),
    claimMemberCode: unused('claimMemberCode'),
    claimCardToken: unused('claimCardToken'),
    recordPass: unused('recordPass'),
    recordPassReconciliation: unused('recordPassReconciliation'),
    recordPassLifecycle: unused('recordPassLifecycle'),
    recordPassObservation: unused('recordPassObservation'),
    recordPassExpired: unused('recordPassExpired'),
  } as unknown as WalletStore;

  return { store, rotations, customer: () => customer, pass: () => pass, rotateCardToken };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

type FakeClient = GoogleWalletClient & { getObject: Mock; patchObject: Mock };

function fakeClient(
  options: { failWith?: Error; echo?: (stored: LoyaltyObject) => unknown; initial?: LoyaltyObject } = {},
): FakeClient {
  let current: LoyaltyObject = options.initial ?? savedObject();

  const notUsed = (name: string) =>
    vi.fn(async () => {
      throw new Error(`${name} is not part of the rotation path`);
    });

  return {
    getClass: notUsed('getClass'),
    insertClass: notUsed('insertClass'),
    insertObject: notUsed('insertObject'),
    listObjects: notUsed('listObjects'),
    saveUriForJwt: notUsed('saveUriForJwt'),
    addMessage: notUsed('addMessage'),
    getObject: vi.fn(async () => current),
    patchObject: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      if (options.failWith) throw options.failWith;
      current = { ...current, ...patch } as LoyaltyObject;
      return (options.echo ? options.echo(current) : current) as LoyaltyObject;
    }),
  } as unknown as FakeClient;
}

function install(store: FakeStore, client: FakeClient) {
  vi.mocked(openTenantWalletStore).mockReturnValue(store.store);
  vi.mocked(googleWalletClientFor).mockReturnValue(client);
}

const input = { tenantId: TENANT, customerId: CUSTOMER_ID, actorUserId: ACTOR, reason: REASON };

// ============================================================================

describe('rotateCardToken RPC', () => {
  it('is exported on the default export next to the other RPCs', () => {
    expect(defaultExport.rotateCardToken).toBe(rotateCardToken);
  });

  it('migrates a legacy customer to version 1, audits it and rewrites only the barcode', async () => {
    const store = fakeStore();
    const client = fakeClient();
    install(store, client);

    const result = await rotateCardToken(input, env as never);

    expect(result).toEqual({ ok: true, version: 1, pass: 'updated' });
    const token = await tokenFor(1);
    // The audit row: who, why, from which version to which.
    expect(store.rotations).toEqual([
      {
        customerId: CUSTOMER_ID,
        tenantId: TENANT,
        expectedVersion: null,
        newVersion: 1,
        newHash: await hashCardToken(token),
        actorUserId: ACTOR,
        reason: REASON,
      },
    ]);
    // A barcode-only patch: no arrays, no balance, no tier, no name.
    expect(client.patchObject).toHaveBeenCalledTimes(1);
    expect(client.patchObject).toHaveBeenCalledWith(OBJECT_ID, {
      barcode: { type: 'QR_CODE', value: token },
    });
  });

  it('bumps a tokened customer from n to n+1 and the old token stops matching', async () => {
    const v2 = await tokenFor(2);
    const store = fakeStore({
      customer: customerRow({ cardTokenVersion: 2, cardTokenHash: await hashCardToken(v2) }),
    });
    const client = fakeClient({ initial: savedObject(v2) });
    install(store, client);

    const result = await rotateCardToken(input, env as never);

    expect(result).toEqual({ ok: true, version: 3, pass: 'updated' });
    expect(store.rotations[0]).toMatchObject({ expectedVersion: 2, newVersion: 3 });
    const v3 = await tokenFor(3);
    expect(store.customer()!.cardTokenHash).toBe(await hashCardToken(v3));
    expect(store.customer()!.cardTokenHash).not.toBe(await hashCardToken(v2));
    expect(client.patchObject.mock.calls[0]![1]).toEqual({ barcode: { type: 'QR_CODE', value: v3 } });
  });

  it('keeps object_id identical (S6)', async () => {
    const store = fakeStore();
    const client = fakeClient();
    install(store, client);
    const before = store.pass()!.objectId;

    await rotateCardToken(input, env as never);

    // The patch targets the recorded id, Google still answers that id, and the
    // pass row was never written.
    expect(client.patchObject.mock.calls[0]![0]).toBe(before);
    expect((await client.getObject(OBJECT_ID))!.id).toBe(before);
    expect(store.pass()!.objectId).toBe(before);
    expect(before).toBe(OBJECT_ID);
  });

  it('does not touch the balance, the tier or the history (S9)', async () => {
    const store = fakeStore();
    const client = fakeClient();
    install(store, client);

    await rotateCardToken(input, env as never);

    const patch = client.patchObject.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('loyaltyPoints');
    expect(patch).not.toHaveProperty('textModulesData');
    expect(patch).not.toHaveProperty('accountId');
    expect(patch).not.toHaveProperty('state');
    expect(patch).not.toHaveProperty('replaceArrays');
    // The tier on the customer row is untouched; the only store write was the
    // rotation (the fake throws on any ledger, member-code or pass-row write).
    expect(store.customer()!.currentTierId).toBe('tier-gold');
    expect(store.customer()!.memberCode).toBe(MEMBER_CODE);
    expect(store.rotateCardToken).toHaveBeenCalledTimes(1);
    // Google's balance is what it was.
    expect((await client.getObject(OBJECT_ID))!.loyaltyPoints.balance.string).toBe('400');
  });

  it('confirms the barcode against the object Google stored', async () => {
    // Google answers a different barcode: the rotation is not confirmed.
    const store = fakeStore();
    const client = fakeClient({
      echo: (stored) => ({ ...stored, barcode: { type: 'QR_CODE', value: 'something-else' } }),
    });
    install(store, client);

    const result = await rotateCardToken(input, env as never);

    expect(result).toMatchObject({ ok: false, code: 'PASS_UPDATE_FAILED' });
    if (!result.ok) expect(result.message).toContain('barcode.value (different)');
  });

  it('re-reads once when the patch echo is partial, and confirms from the read', async () => {
    const store = fakeStore();
    const client = fakeClient({ echo: (stored) => ({ id: stored.id }) });
    install(store, client);

    const result = await rotateCardToken(input, env as never);

    expect(result).toEqual({ ok: true, version: 1, pass: 'updated' });
    expect(client.getObject).toHaveBeenCalledWith(OBJECT_ID);
  });

  it('returns PASS_UPDATE_FAILED after the DB write when Google refuses the patch', async () => {
    const store = fakeStore();
    const client = fakeClient({
      failWith: new GoogleWalletApiError(500, 'INTERNAL', []),
    });
    install(store, client);

    const result = await rotateCardToken(input, env as never);

    expect(result).toMatchObject({ ok: false, code: 'PASS_UPDATE_FAILED' });
    // The version already moved and was audited: a retry is another rotation.
    expect(store.rotations).toHaveLength(1);
    expect(store.customer()!.cardTokenVersion).toBe(1);
  });

  it("never puts the raw token or the global id in the result message or the logs", async () => {
    const store = fakeStore();
    const client = fakeClient({
      echo: (stored) => ({ ...stored, barcode: { type: 'QR_CODE', value: 'something-else' } }),
    });
    install(store, client);

    const result = await rotateCardToken(input, env as never);

    const token = await tokenFor(1);
    const logged = [
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]
      .flat()
      .map((part) => String(part))
      .join('\n');
    const message = result.ok ? '' : result.message;
    for (const secretish of [token, GLOBAL_ID]) {
      expect(message).not.toContain(secretish);
      expect(logged).not.toContain(secretish);
    }
  });

  it("answers pass: 'none' when Google holds no object, after the DB write", async () => {
    for (const pass of [null, passRow({ state: 'not_issued' }), passRow({ state: 'not_saved' })]) {
      const store = fakeStore({ pass });
      const client = fakeClient();
      install(store, client);

      const result = await rotateCardToken(input, env as never);

      expect(result).toEqual({ ok: true, version: 1, pass: 'none' });
      expect(store.rotations).toHaveLength(1);
      expect(client.patchObject).not.toHaveBeenCalled();
    }
  });

  it('answers CUSTOMER_NOT_FOUND and writes nothing for an unknown customer', async () => {
    const store = fakeStore({ customer: null });
    const client = fakeClient();
    install(store, client);

    const result = await rotateCardToken(input, env as never);

    expect(result).toMatchObject({ ok: false, code: 'CUSTOMER_NOT_FOUND' });
    expect(store.rotateCardToken).not.toHaveBeenCalled();
    expect(client.patchObject).not.toHaveBeenCalled();
  });

  it('retries from the stored version when a concurrent rotation moved it', async () => {
    const store = fakeStore({ raceOnce: true });
    const client = fakeClient();
    install(store, client);

    const result = await rotateCardToken(input, env as never);

    // The racing rotation took version 1, so this one lands on 2.
    expect(result).toEqual({ ok: true, version: 2, pass: 'updated' });
    expect(store.rotations[0]).toMatchObject({ expectedVersion: 1, newVersion: 2 });
    expect(isCardToken((client.patchObject.mock.calls[0]![1] as LoyaltyObject).barcode.value)).toBe(true);
  });

  it('refuses an empty CARD_TOKEN_SECRET before writing anything', async () => {
    const store = fakeStore();
    const client = fakeClient();
    install(store, client);

    await expect(rotateCardToken(input, { ...env, CARD_TOKEN_SECRET: '' } as never)).rejects.toThrow(
      /CARD_TOKEN_SECRET is empty/,
    );
    expect(store.rotateCardToken).not.toHaveBeenCalled();
  });
});
