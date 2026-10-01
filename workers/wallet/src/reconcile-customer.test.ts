// The `vi.mock` factories below are hoisted above every import in this file, which
// is why the module under test is imported after them. Same shape as
// `routes.test.ts`.

// ---------------------------------------------------------------------------
// Module-level mocks
//
// Three seams, and only three. `reconcilePass` itself is **not** mocked: this
// file is about what `reconcileCustomer` does around the projection, and a suite
// that stubbed the projection itself could not tell delegation from
// reimplementation — the exact distinction these tests exist to pin.
// ---------------------------------------------------------------------------

vi.mock('./drizzle-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('./drizzle-store')>();
  return { ...original, createDrizzleWalletStore: vi.fn(), openTenantSession: vi.fn() };
});

// The real helpers, with the one function that can reach the network replaced.
// Same reasoning as `routes.test.ts`: without this, the first assertion here
// would attempt a real token exchange with Google.
vi.mock('./helpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('./helpers')>();
  return { ...original, googleWalletClientFor: vi.fn() };
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { BALANCE_DISPLAY_MAX } from './balance';
import { createDrizzleWalletStore, openTenantSession } from './drizzle-store';
import type { GoogleWalletClient } from './google-client';
import { googleWalletClientFor } from './helpers';
import { classIdFor } from './ids';
import type { LoyaltyObject } from './object';
import { PassPatchNotAppliedError } from './reconcile';
import type { WalletPassRow, WalletProgramRow, WalletStore } from './store';

import { reconcileCustomer } from './index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = '3388000000023206930';
const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const OTHER_TENANT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CUSTOMER_ID = 'd185c973-c976-46b5-b3bf-06185739a941';
const OTHER_CUSTOMER_ID = 'b3f1c0d2-5e6a-4a7b-1e2f3a4b5c6d';
const OBJECT_ID = `${ISSUER}.member-c8b61954-1b6d-4dfa-9954-b7c936a9e648`;
const CURRENCY = 'puntos';

let env: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  env = {
    DATABASE_URL: 'postgres://mock',
    GOOGLE_WALLET_ISSUER_ID: ISSUER,
    GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: 'wallet@vyloop-demo.iam.gserviceaccount.com',
    GOOGLE_WALLET_PRIVATE_KEY: 'not-a-real-key',
    MEMBER_CODE_PEPPER: crypto.randomUUID(),
    WALLET_ALLOWED_ORIGINS: 'https://app.vyloop.app',
    // Demo mode is a ceiling on a deployment, and `parseDemoMode` fails closed,
    // so an environment that has publishing access has to say so. Every case
    // below is about the post-approval world; the var's own behaviour is pinned
    // in `helpers.test.ts`.
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

// ---------------------------------------------------------------------------
// The store
//
// Every method `reconcilePass` can reach is a `vi.fn`, because two of the tests
// here assert on call *counts*: that the program is read exactly once (so the
// entry point did not add a second readiness check) and that a customer's pass
// is looked up at all. Anything it would not call throws rather than returning
// `undefined`, so a projection that grows a new dependency fails loudly.
// ---------------------------------------------------------------------------

interface FakeStore {
  store: WalletStore;
  findProgram: Mock;
  findPass: Mock;
  latestBalance: Mock;
  findPointsCurrency: Mock;
  recordPassReconciliation: Mock;
}

function fakeStore(overrides: {
  program?: WalletProgramRow | null;
  pass?: WalletPassRow | null;
  balance?: number;
  currency?: string | null;
  tenantId?: string;
  customerId?: string;
} = {}): FakeStore {
  const findProgram = vi.fn(async () => (overrides.program === undefined ? programRow() : overrides.program));
  // The tenant predicate is honoured rather than stubbed, exactly as in
  // `reconcile.test.ts`: a fake that returns a row for any tenant would make the
  // scoping test below pass for the wrong reason — it would be measuring a store
  // that cannot represent the leak it is looking for.
  const findPass = vi.fn(async (customerId: string, tenantId: string) => {
    const row = overrides.pass === undefined ? passRow() : overrides.pass;
    if (row === null) return null;
    if (row.tenantId !== tenantId || row.customerId !== customerId) return null;
    return row;
  });
  const latestBalance = vi.fn(async () => overrides.balance ?? 400);
  const findPointsCurrency = vi.fn(async () =>
    overrides.currency === undefined ? CURRENCY : overrides.currency,
  );
  const recordPassReconciliation = vi.fn(async () => 1);

  const unused = (name: string) =>
    vi.fn(async (): Promise<never> => {
      throw new Error(`${name} is not part of the reconcile path and was not expected to be called`);
    });

  const store = {
    findProgram,
    findPass,
    latestBalance,
    findPointsCurrency,
    recordPassReconciliation,
    recordPassObservation: unused('recordPassObservation'),
    recordPassLifecycle: unused('recordPassLifecycle'),
    findCustomer: unused('findCustomer'),
    findCustomerById: unused('findCustomerById'),
    findTierName: unused('findTierName'),
    recordPass: unused('recordPass'),
    isMemberCodeTaken: unused('isMemberCodeTaken'),
    claimMemberCode: unused('claimMemberCode'),
    listProgramTenants: unused('listProgramTenants'),
    listTenantsWithoutProgram: unused('listTenantsWithoutProgram'),
    findPassesByObjectIds: unused('findPassesByObjectIds'),
  } as unknown as WalletStore;

  return { store, findProgram, findPass, latestBalance, findPointsCurrency, recordPassReconciliation };
}

// ---------------------------------------------------------------------------
// The client
//
// Stateful, for the reason given in `reconcile.test.ts`: a fake that cannot
// represent a patched object makes an idempotency assertion pass for the wrong
// reason.
// ---------------------------------------------------------------------------

type FakeClient = GoogleWalletClient & { getObject: Mock; patchObject: Mock; getClass: Mock };

function fakeClient(remote: LoyaltyObject | null, options: { echoPatch?: boolean } = {}): FakeClient {
  let current = remote;

  return {
    getClass: vi.fn(async () => null),
    insertClass: vi.fn(async () => {
      throw new Error('not used');
    }),
    patchClass: vi.fn(async () => {
      throw new Error('not used');
    }),
    getObject: vi.fn(async () => current),
    insertObject: vi.fn(async () => {
      throw new Error('not used');
    }),
    patchObject: vi.fn(async (_id: string, patch: { loyaltyPoints?: LoyaltyObject['loyaltyPoints'] }) => {
      // The `echoPatch: false` case is Google's "accepted it, changed nothing",
      // which is what `PassPatchNotAppliedError` exists to catch.
      if (options.echoPatch === false) return current;
      current = {
        ...(current as LoyaltyObject),
        ...(patch.loyaltyPoints ? { loyaltyPoints: patch.loyaltyPoints } : {}),
      };
      return current;
    }),
    listObjects: vi.fn(async () => ({ objects: [], nextPageToken: null })),
    saveUriForJwt: vi.fn(async () => {
      throw new Error('not used');
    }),
  } as unknown as FakeClient;
}

function objectWithBalance(balance: string): LoyaltyObject {
  return {
    id: OBJECT_ID,
    classId: classIdFor(ISSUER, TENANT),
    state: 'ACTIVE',
    accountId: 'K7M2QX',
    loyaltyPoints: { label: CURRENCY, balance: { string: balance } },
    barcode: { type: 'QR_CODE', value: 'c8b61954-1b6d-4dfa-9954-b7c936a9e648' },
  };
}

/** Wire the fakes into the two seams, and return them for assertions. */
function install(
  store: FakeStore,
  client: FakeClient,
  input: { tenantId?: string; customerId?: string } = {},
) {
  vi.mocked(createDrizzleWalletStore).mockReturnValue(store.store);
  vi.mocked(openTenantSession).mockResolvedValue({} as never);
  vi.mocked(googleWalletClientFor).mockReturnValue(client);

  return reconcileCustomer(
    { tenantId: input.tenantId ?? TENANT, customerId: input.customerId ?? CUSTOMER_ID },
    env as never,
  );
}

// ============================================================================
// What the entry point is
// ============================================================================

describe('reconcileCustomer: it is the push trigger, and it delegates', () => {
  it('projects the ledger balance onto the pass, through reconcilePass', async () => {
    const store = fakeStore({ balance: 400 });
    const client = fakeClient(objectWithBalance('250'));

    const outcome = await install(store, client);

    expect(outcome).toEqual({ kind: 'patched', objectId: OBJECT_ID, balancePoints: 400 });
    expect(client.patchObject).toHaveBeenCalledWith(OBJECT_ID, {
      loyaltyPoints: { label: CURRENCY, balance: { string: '400' } },
    });
  });

  it('reads the program once and never asks Google for the class itself', async () => {
    // The whole "do not re-gate" claim, measured. A second implementation of
    // "is this class usable" would either read the program again or fetch the
    // class from Google, and both are observable here. One read, zero class
    // reads: the only readiness decision is `reconcilePass`'s.
    const store = fakeStore({ balance: 400 });
    const client = fakeClient(objectWithBalance('250'));

    await install(store, client);

    expect(store.findProgram).toHaveBeenCalledTimes(1);
    expect(client.getClass).not.toHaveBeenCalled();
  });

  it('opens a tenant session before reading, so the projection survives RLS', async () => {
    // The sweep deliberately opens none, because it enumerates tenants. This call
    // already knows its tenant, and every route in this worker opens one. Read
    // without it and the day the policies are enabled, `findPass` and
    // `latestBalance` return nothing and this reports `no_tracking_row` — a
    // balance that silently stops converging, with no error anywhere.
    const store = fakeStore({ balance: 400 });
    const client = fakeClient(objectWithBalance('250'));

    await install(store, client);

    expect(openTenantSession).toHaveBeenCalledWith('postgres://mock', TENANT);
    expect(store.findProgram).toHaveBeenCalledWith(TENANT);
  });

  it("passes the deployment's demo mode into the gate instead of assuming one", async () => {
    // `WALLET_DEMO_MODE` absent is demo mode, and `parseDemoMode` fails closed.
    // A class still under review is acceptable in demo mode and refused without
    // it, so this case only reaches a Google write if the var was read and
    // threaded through rather than hardcoded either way.
    const store = fakeStore({
      program: programRow({ reviewStatus: 'in_review' }),
      balance: 400,
    });
    const client = fakeClient(objectWithBalance('250'));
    delete env.WALLET_DEMO_MODE;

    const outcome = await install(store, client);

    expect(outcome.kind).toBe('patched');
  });

  it('reports the gate’s own refusal when a deployment without publishing access meets a class under review', async () => {
    // The counterpart: same row, demo mode off, and the projection is refused
    // before anything is asked of Google. The reason code comes from
    // `reasonCodeFor`, so the caller reads a vocabulary it does not own.
    const store = fakeStore({
      program: programRow({ reviewStatus: 'in_review' }),
      balance: 400,
    });
    const client = fakeClient(objectWithBalance('250'));

    const outcome = await install(store, client);

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'class_not_approved' });
    expect(client.getObject).not.toHaveBeenCalled();
    expect(client.patchObject).not.toHaveBeenCalled();
  });
});

// ============================================================================
// What it must not bypass
// ============================================================================

describe('reconcileCustomer: the refusals survive the new path', () => {
  it('refuses to push a balance no pass can display, and writes nothing to Google', async () => {
    // Redemption is the operation that can drive a balance to a number the pass
    // cannot render, which is why the redeem handler is the case worth watching.
    // `reconcilePass` already refuses, so the only thing that can go wrong here
    // is the new path doing something on its way in — truncating, rounding, or
    // patching before the check. Both are observable as a `patchObject` call.
    const store = fakeStore({ balance: BALANCE_DISPLAY_MAX + 1 });
    const client = fakeClient(objectWithBalance('250'));

    const outcome = await install(store, client);

    expect(outcome).toEqual({ kind: 'balance_not_displayable', points: BALANCE_DISPLAY_MAX + 1 });
    expect(client.patchObject).not.toHaveBeenCalled();
    // The check happens after the observation, not instead of it, so a pass in
    // this state is still confirmed to exist at Google.
    expect(client.getObject).toHaveBeenCalledWith(OBJECT_ID);
  });

  it('treats a pass belonging to another tenant as no pass at all', async () => {
    // The tenant is the caller's, not the row's. A projection that looked the
    // pass up without it would push one merchant's balance onto another
    // merchant's pass, so the miss is asserted rather than assumed.
    const store = fakeStore({ pass: passRow({ tenantId: OTHER_TENANT, customerId: OTHER_CUSTOMER_ID }), balance: 400 });
    const client = fakeClient(objectWithBalance('250'));

    const outcome = await install(store, client);

    expect(outcome).toEqual({ kind: 'no_tracking_row' });
    expect(client.getObject).not.toHaveBeenCalled();
    expect(client.patchObject).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Failures
// ============================================================================

describe('reconcileCustomer: what it throws, and what the caller gets', () => {
  it('rejects when Google accepted a patch that did not carry the number', async () => {
    // Swallowing this would report success for a pass showing the wrong balance,
    // which is the one outcome this worker treats as a trust problem at the
    // till. So the error crosses the RPC boundary and the caller logs it.
    const store = fakeStore({ balance: 400 });
    const client = fakeClient(objectWithBalance('250'), { echoPatch: false });

    await expect(install(store, client)).rejects.toBeInstanceOf(PassPatchNotAppliedError);
  });

  it('issues no write for a customer who has not saved their pass', async () => {
    // The ordinary case for a customer who never saved: a definitive answer,
    // recorded, and no Google write. It is the path that makes firing on every
    // sale safe — a tenant full of un-saved passes produces reads, not patches.
    const store = fakeStore({ balance: 400 });
    const client = fakeClient(null);

    const outcome = await install(store, client);

    expect(outcome).toEqual({ kind: 'not_saved', objectId: OBJECT_ID });
    expect(client.patchObject).not.toHaveBeenCalled();
    expect(store.recordPassReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, tenantId: TENANT, state: 'not_saved' }),
    );
  });
});
