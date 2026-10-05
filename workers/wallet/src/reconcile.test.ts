import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { BALANCE_DISPLAY_MAX } from './balance';
import type { GoogleWalletClient } from './google-client';
import { classIdFor } from './ids';
import type { LoyaltyObject } from './object';
import {
  PassPatchNotAppliedError,
  reconcilePass,
} from './reconcile';
import type {
  PassLifecycleUpdate,
  PassObservationUpdate,
  PassReconciliationUpdate,
  WalletPassRow,
  WalletProgramRow,
  WalletStore,
  WalletTenantBrandingRow,
} from './store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = '3388000000023206930';
const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const OTHER_TENANT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CUSTOMER_ID = 'd185c973-c976-46b5-b3bf-06185739a941';
const OTHER_CUSTOMER_ID = 'b3f1c0d2-5e6a-4a7b-9c8d-1e2f3a4b5c6d';
const OBJECT_ID = `${ISSUER}.member-c8b61954-1b6d-4dfa-9954-b7c936a9e648`;
const CURRENCY = 'puntos';
const OBSERVED_AT = new Date('2026-09-28T12:00:00.000Z');

function programRow(overrides: Partial<WalletProgramRow> = {}): WalletProgramRow {
  return {
    tenantId: TENANT,
    issuerId: ISSUER,
    classId: classIdFor(ISSUER, TENANT),
    reviewStatus: 'approved',
    // Explicit, because a row read after the migration always carries the column
    // and an absent one is treated as demo mode. Leaving it out would make every
    // case below about that fallback rather than about what it tests.
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
    state: 'not_issued',
    lastSyncedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A fake store that records every call and answers per tenant
//
// Same discipline as `issuance.test.ts`: the tenant is a parameter, every call
// records the tenant it was given, and rows are looked up per tenant. A test
// that hands the wrong tenant therefore sees a real miss rather than another
// tenant's data.
// ---------------------------------------------------------------------------

class FakeStore implements WalletStore {
  readonly calls: Array<{ method: string; tenantId: string }> = [];
  readonly reconciliations: PassReconciliationUpdate[] = [];
  readonly lifecycles: PassLifecycleUpdate[] = [];
  readonly observations: PassObservationUpdate[] = [];
  readonly tenantPageRequests: Array<{ limit: number; afterTenantId: string | null }> = [];

  constructor(
    public readonly programs: Record<string, WalletProgramRow | null>,
    public readonly passes: Record<string, WalletPassRow | null>,
    public balances: Record<string, number> = {},
    public currencies: Record<string, string | null> = {},
  ) {}

  private record(method: string, tenantId: string): void {
    this.calls.push({ method, tenantId });
  }

  /** Every tenant any method was asked about. For leak assertions. */
  tenantsTouched(): string[] {
    return [...new Set(this.calls.map((call) => call.tenantId))];
  }

  methodsCalled(): string[] {
    return this.calls.map((call) => call.method);
  }

  async findCustomer(): Promise<null> {
    this.record('findCustomer', TENANT);
    return null;
  }

  async findCustomerById(): Promise<null> {
    this.record('findCustomerById', TENANT);
    return null;
  }

  async findProgram(tenantId: string): Promise<WalletProgramRow | null> {
    this.record('findProgram', tenantId);
    return this.programs[tenantId] ?? null;
  }

  // Provisioning's three methods. They throw rather than answering, so a
  // reconciliation that reached for one would be reaching for a second answer
  // to a question `findProgram` already owns.
  async insertProgram(): Promise<void> {
    throw new Error('insertProgram is not part of the reconciliation path');
  }

  async findTenantBranding(): Promise<WalletTenantBrandingRow | null> {
    throw new Error('findTenantBranding is not part of the reconciliation path');
  }

  async findProgramName(): Promise<string | null> {
    throw new Error('findProgramName is not part of the reconciliation path');
  }

  async findPointsCurrency(tenantId: string): Promise<string | null> {
    this.record('findPointsCurrency', tenantId);
    return tenantId in this.currencies ? this.currencies[tenantId] : null;
  }

  /**
   * Absent. Reconciliation patches the balance and nothing else, so the promo
   * copy never enters this path: it lives on the class, and Google's patch
   * semantics leave a class field alone.
   */
  async findPromoCopy(): Promise<null> {
    this.record('findPromoCopy', '');
    return null;
  }

  async findTierName(): Promise<null> {
    this.record('findTierName', TENANT);
    return null;
  }

  async latestBalance(customerId: string, tenantId: string): Promise<number> {
    this.record('latestBalance', tenantId);
    return this.balances[`${tenantId}:${customerId}`] ?? 0;
  }

  async isMemberCodeTaken(): Promise<boolean> {
    this.record('isMemberCodeTaken', TENANT);
    return false;
  }

  async claimMemberCode(): Promise<string | null> {
    this.record('claimMemberCode', TENANT);
    return null;
  }

  async recordPass(): Promise<void> {
    this.record('recordPass', TENANT);
  }

  async findPass(customerId: string, tenantId: string): Promise<WalletPassRow | null> {
    this.record('findPass', tenantId);
    const row = this.passes[tenantId];
    // The primary key and the tenant together, the way the real predicate does
    // it. A row belonging to another tenant is a miss, not a hit.
    if (row === undefined || row === null) return null;
    if (row.tenantId !== tenantId || row.customerId !== customerId) return null;
    return row;
  }

  async recordPassReconciliation(update: PassReconciliationUpdate): Promise<number> {
    this.record('recordPassReconciliation', update.tenantId);
    this.reconciliations.push(update);
    const row = this.passes[update.tenantId];
    if (row && row.tenantId === update.tenantId) {
      // The monotonicity guard the real store puts in a `CASE`, mirrored here so a
      // test that relies on it is relying on the same rule rather than on the fake
      // being more forgiving. The rule is `state IN ('not_issued', 'not_saved',
      // 'inactive')`: the state only moves while the row is weaker than what is
      // written, and nothing else.
      //
      // The timestamp is **not** inside that guard — it advances on every
      // definitive answer, whatever the state transition was allowed to do. That
      // split is the real store's, and it is load bearing: guarding the
      // timestamp too left a terminal row permanently in the sweep's due set.
      if (row.state === 'not_issued' || row.state === 'not_saved' || row.state === 'inactive') {
        row.state = update.state;
      }
      row.lastSyncedAt = update.observedAt;
      return 1;
    }
    return 0;
  }

  async recordPassLifecycle(update: PassLifecycleUpdate): Promise<number> {
    this.record('recordPassLifecycle', update.tenantId);
    this.lifecycles.push(update);
    const row = this.passes[update.tenantId];
    if (row && row.tenantId === update.tenantId) {
      // The lifecycle guard: writable only from a row that already asserts the
      // object exists, so `expired` and `completed` are terminal and
      // `not_issued`/`not_saved` can never be advanced by a lifecycle answer.
      //
      // The timestamp is inside this guard, exactly as it is in the real
      // statement, so a refused write leaves the row completely untouched and
      // returns 0. Stamping it anyway would be the defect this fake used to
      // have, and it would hide the case the sweep has to count as skipped.
      if (row.state === 'issued' || row.state === 'inactive') {
        row.state = update.state;
        row.lastSyncedAt = update.observedAt;
        return 1;
      }
    }
    return 0;
  }

  async recordPassObservation(update: PassObservationUpdate): Promise<number> {
    this.record('recordPassObservation', update.tenantId);
    this.observations.push(update);
    const row = this.passes[update.tenantId];
    if (row && row.tenantId === update.tenantId) {
      // No state, and no state predicate. The only guard is the tenant, because
      // the only thing this writes is "Google answered, at this time".
      row.lastSyncedAt = update.observedAt;
      return 1;
    }
    return 0;
  }

  async listProgramTenants(options: {
    limit: number;
    afterTenantId: string | null;
  }): Promise<WalletProgramRow[]> {
    this.record('listProgramTenants', options.afterTenantId ?? '');
    this.tenantPageRequests.push({ limit: options.limit, afterTenantId: options.afterTenantId });
    const all = Object.values(this.programs)
      .filter((row): row is WalletProgramRow => row !== null && row !== undefined)
      .sort((a, b) => (a.tenantId < b.tenantId ? -1 : 1));
    const start =
      options.afterTenantId === null
        ? 0
        : all.findIndex((row) => row.tenantId === options.afterTenantId) + 1;
    return all.slice(start, start + options.limit);
  }

  /**
   * The provisioning enumeration throws here on purpose, the same way the
   * provisioning methods above do.
   *
   * Reconciliation and provisioning are different work with different readiness
   * semantics: `classReadinessFor` rejects anything that is not `approved`, and
   * every tenant missing a program row is `class_not_provisioned`. Letting the
   * reconciler reach for the unprovisioned set is how "keep the passes in sync"
   * quietly turns into "create a class for everyone on the schedule".
   *
   * A silent no-op would be the worse outcome: the sweep would report healthy
   * counters and the businesses that need a class would stay without one.
   */
  async listTenantsWithoutProgram(): Promise<string[]> {
    throw new Error('listTenantsWithoutProgram is not part of the reconciliation path');
  }

  async findPassesByObjectIds(objectIds: string[], tenantId: string): Promise<WalletPassRow[]> {
    this.record('findPassesByObjectIds', tenantId);
    const row = this.passes[tenantId];
    // Tenant-scoped, the way the real `= ANY(object_id)` predicate is. A row
    // belonging to another tenant is not returned, so a sweep cannot see it.
    if (!row || row.tenantId !== tenantId) return [];
    return objectIds.includes(row.objectId) ? [row] : [];
  }

  /**
   * The pass-inactivity rule's query. Unreachable from this suite: the rule has its
   * own module and its own fake store, and a fake that quietly answered it would
   * let a caller reach it without any test noticing.
   */
  async findInactivePassCandidates(): Promise<never> {
    throw new Error('findInactivePassCandidates is not used by this test suite.');
  }

  async setProgramDemoMode(): Promise<number> {
    this.record('setProgramDemoMode', TENANT);
    return 1;
  }

  // Callback methods, present only to satisfy the interface. The reconciliation
  // path must never call them, so reaching one is a hard failure rather than a
  // quiet no-op that a test would pass on.
  async findTenantByClassId(): Promise<null> {
    throw new Error('reconcilePass must not resolve a tenant from a class id');
  }
  async claimCallbackDelivery(): Promise<boolean> {
    throw new Error('reconcilePass must not claim a callback delivery');
  }
  async recordPassCallback(): Promise<number> {
    throw new Error('reconcilePass must not record a callback');
  }

  async updateProgramReviewStatus(): Promise<void> {
    this.record('updateProgramReviewStatus', TENANT);
  }
}

// ---------------------------------------------------------------------------
// A fake Google client
//
// Every method is a `vi.fn`, so a test can assert on what was *not* called, and
// there is no socket anywhere in this file.
// ---------------------------------------------------------------------------

function fakeObject(overrides: Partial<LoyaltyObject> = {}): LoyaltyObject {
  return {
    id: OBJECT_ID,
    classId: classIdFor(ISSUER, TENANT),
    state: 'ACTIVE',
    accountId: 'K7M2QX',
    loyaltyPoints: { label: CURRENCY, balance: { string: '96942' } },
    barcode: { type: 'QR_CODE', value: 'c8b61954-1b6d-4dfa-9954-b7c936a9e648' },
    ...overrides,
  };
}

/**
 * A `LoyaltyObject` holding a given balance.
 *
 * A helper rather than an inline literal because the shape nests four deep and
 * an unbalanced brace in a fixture is a syntax error that costs a whole run to
 * find.
 */
function objectWithBalance(balance: string, overrides: Partial<LoyaltyObject> = {}): LoyaltyObject {
  return fakeObject({
    loyaltyPoints: { label: CURRENCY, balance: { string: balance } },
    ...overrides,
  });
}

/**
 * The interface, with the three methods a test asserts on widened to mocks.
 *
 * An intersection rather than `interface FakeClient extends GoogleWalletClient`
 * on purpose: the `vi.fn` signature is wider than each method's, and an
 * interface extension demands the override be assignable, which a mock is not.
 */
type FakeClient = GoogleWalletClient & {
  getObject: Mock;
  patchObject: Mock;
  getClass: Mock;
  insertObject: Mock;
  listObjects: Mock;
};

/**
 * A client that behaves like Google's: stateful, and self-consistent.
 *
 * The `getObject` closure reads the *current* remote rather than the one it was
 * built with, and `patchObject` applies to it. Without that, a second
 * reconciliation would see the pre-patch balance forever and patch again, and
 * the idempotency test would pass for the wrong reason — it would be measuring
 * a fake that cannot represent the thing being tested.
 */
function fakeClient(remote: LoyaltyObject | null): FakeClient {
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
    // Echo the stored resource back, as Google's `callForResource` does, and
    // leave it as the new truth. A patch that returns what it was sent is what
    // makes the post-condition check in `reconcilePass` meaningful rather than
    // vacuous.
    patchObject: vi.fn(async (_id: string, patch: { loyaltyPoints?: LoyaltyObject['loyaltyPoints'] }) => {
      current = fakeObject({
        ...(current ?? {}),
        ...(patch.loyaltyPoints ? { loyaltyPoints: patch.loyaltyPoints } : {}),
      });
      return current;
    }),
    listObjects: vi.fn(async () => ({ objects: [], nextPageToken: null })),
    saveUriForJwt: vi.fn(async () => {
      throw new Error('not used');
    }),
  } as unknown as FakeClient;
}

function readyStore(overrides: {
  pass?: WalletPassRow | null;
  balance?: number;
  program?: WalletProgramRow | null;
} = {}): FakeStore {
  return new FakeStore(
    { [TENANT]: overrides.program === undefined ? programRow() : overrides.program },
    { [TENANT]: overrides.pass === undefined ? passRow() : overrides.pass },
    { [`${TENANT}:${CUSTOMER_ID}`]: overrides.balance ?? 96942 },
    { [TENANT]: CURRENCY },
  );
}

function reconcile(
  store: WalletStore,
  client: GoogleWalletClient,
  tenantId = TENANT,
  demoMode = false,
) {
  return reconcilePass(
    { store, client, now: OBSERVED_AT, demoMode },
    { tenantId, customerId: CUSTOMER_ID },
  );
}

let store: FakeStore;
let client: FakeClient;

beforeEach(() => {
  store = readyStore();
  // Google's copy deliberately disagrees with the ledger, so the default path
  // through `reconcilePass` is a patch. A test that wants the other branch says
  // so by giving Google the ledger's number, which is also how the idempotency
  // tests state theirs.
  client = fakeClient(objectWithBalance('0'));
});

// ============================================================================
// Learning that the pass was saved
// ============================================================================

describe('reconcilePass: learning the pass was saved', () => {
  it('asks Google, and only Google, and never infers it from having issued a link', async () => {
    // The whole design in one assertion. `recordPass` ran when the link was
    // handed out; that proves nothing about Google, so the only thing that can
    // move the state is an actual read of the object.
    const outcome = await reconcile(store, client);

    expect(client.getObject).toHaveBeenCalledTimes(1);
    expect(client.getObject).toHaveBeenCalledWith(OBJECT_ID);
    expect(outcome.kind).toBe('patched');
  });

  it('records `not_saved` when Google has no object, which is not the same as `not_issued`', async () => {
    // `not_issued` is "we never checked". `not_saved` is "we checked, and it is
    // not there". A merchant reading the second as the first is told a customer
    // has no pass when we simply had no answer.
    client = fakeClient(null);

    const outcome = await reconcile(store, client);

    expect(outcome).toEqual({ kind: 'not_saved', objectId: OBJECT_ID });
    expect(store.reconciliations).toEqual([
      { customerId: CUSTOMER_ID, tenantId: TENANT, state: 'not_saved', observedAt: OBSERVED_AT },
    ]);
  });

  it('never invents `issued` for a pass Google does not have', async () => {
    client = fakeClient(null);

    await reconcile(store, client);

    expect(store.reconciliations.map((r) => r.state)).not.toContain('issued');
  });

  it('records `issued` once Google does have the object', async () => {
    const outcome = await reconcile(store, client);

    expect(outcome.kind).toBe('patched');
    expect(store.reconciliations).toEqual([
      { customerId: CUSTOMER_ID, tenantId: TENANT, state: 'issued', observedAt: OBSERVED_AT },
    ]);
  });

  it('records `issued` on the no-patch path too, not only when it writes', async () => {
    // The in-sync branch is a different code path with its own state write, and
    // a pass that is already correct is still a pass that exists. Recording
    // anything else here would leave every already-correct pass stuck claiming it
    // was never checked.
    client = fakeClient(objectWithBalance('96942'));

    const outcome = await reconcile(store, client);

    expect(outcome).toEqual({ kind: 'in_sync', objectId: OBJECT_ID });
    expect(store.reconciliations).toEqual([
      { customerId: CUSTOMER_ID, tenantId: TENANT, state: 'issued', observedAt: OBSERVED_AT },
    ]);
    expect(store.passes[TENANT]!.state).toBe('issued');
  });

  it('advances `not_saved` to `issued` once the customer saves the pass', async () => {
    // The state a pass actually travels through, in order.
    client = fakeClient(null);
    store = readyStore();
    expect((await reconcile(store, client)).kind).toBe('not_saved');
    expect(store.passes[TENANT]!.state).toBe('not_saved');

    // The customer follows the link. Google's object now exists and is active.
    store.balances[`${TENANT}:${CUSTOMER_ID}`] = 0;
    const saved = fakeClient(objectWithBalance('0'));

    expect((await reconcile(store, saved)).kind).toBe('in_sync');
    expect(store.passes[TENANT]!.state).toBe('issued');
  });

  it('records the observation time it was given, not the system clock', async () => {
    // `last_synced_at` is a claim about when we last had an answer from Google.
    // A test asserting the shape of that claim has to control the clock.
    await reconcile(store, client);

    expect(store.reconciliations[0]!.observedAt).toEqual(OBSERVED_AT);
  });

  it('does nothing at all when there is no pass row to reconcile', async () => {
    // No row means no recorded `object_id`. Deriving one here would reconcile a
    // pass this system never issued.
    store = readyStore({ pass: null });

    const outcome = await reconcile(store, client);

    expect(outcome).toEqual({ kind: 'no_tracking_row' });
    expect(client.getObject).not.toHaveBeenCalled();
    expect(store.reconciliations).toEqual([]);
  });

  it('patches the object id it recorded, not one derived again', async () => {
    const recorded = `${ISSUER}.member-something-else-entirely`;
    store = readyStore({ pass: passRow({ objectId: recorded }) });

    await reconcile(store, client);

    expect(client.getObject).toHaveBeenCalledWith(recorded);
    expect(client.patchObject).toHaveBeenCalledWith(recorded, expect.anything());
  });
});

// ============================================================================
// Idempotency
// ============================================================================

describe('reconcilePass: idempotency', () => {
  it('writes nothing to Google when the balance already matches', async () => {
    // The gate. Google holds 96942 and the ledger holds 96942, so the comparison
    // is equal and no patch is issued.
    client = fakeClient(objectWithBalance('96942'));

    const outcome = await reconcile(store, client);

    expect(outcome).toEqual({ kind: 'in_sync', objectId: OBJECT_ID });
    expect(client.patchObject).not.toHaveBeenCalled();
  });

  it('issues no Google write across two calls with an unchanged balance', async () => {
    // The property the brief asks for, stated as the caller would exercise it:
    // run it twice, count the writes. Exactly one patch, from the first call.
    const first = await reconcile(store, client);
    expect(first.kind).toBe('patched');
    expect(client.patchObject).toHaveBeenCalledTimes(1);

    // The fake echoes the patch, so the object now holds what the ledger holds.
    // A second call must find them equal.
    const second = await reconcile(store, client);

    expect(second).toEqual({ kind: 'in_sync', objectId: OBJECT_ID });
    expect(client.patchObject).toHaveBeenCalledTimes(1);
  });

  it('is idempotent for a pass Google does not have: no patch, and the state does not move', async () => {
    client = fakeClient(null);
    store = readyStore();

    await reconcile(store, client);
    await reconcile(store, client);

    expect(client.patchObject).not.toHaveBeenCalled();
    expect(store.reconciliations.map((r) => r.state)).toEqual(['not_saved', 'not_saved']);
    expect(store.passes[TENANT]!.state).toBe('not_saved');
  });

  it('still refreshes the observation time when nothing changed', async () => {
    // A timestamp that only moved on a state change could not tell "checked and
    // unchanged" from "never checked", which is the distinction that makes a
    // stale `last_synced_at` meaningful.
    const firstAt = new Date('2026-09-01T00:00:00.000Z');
    store = readyStore({ pass: passRow({ state: 'issued', lastSyncedAt: firstAt }) });

    await reconcile(store, client);

    expect(store.reconciliations[0]!.observedAt).toEqual(OBSERVED_AT);
    expect(store.passes[TENANT]!.lastSyncedAt).toEqual(OBSERVED_AT);
  });

  it('does not downgrade a state it has already advanced', async () => {
    // A 404 after a confirmed 200 is far more likely a propagation artifact
    // than a customer deleting their pass, and a state that flaps is worse for
    // support than one that is a day late.
    store = readyStore({ pass: passRow({ state: 'issued' }) });
    client = fakeClient(null);

    const outcome = await reconcile(store, client);

    expect(outcome.kind).toBe('not_saved');
    expect(store.passes[TENANT]!.state).toBe('issued');
  });

  it('patches again as soon as the ledger moves, and not before', async () => {
    store = readyStore();
    client = fakeClient(objectWithBalance('0'));

    await reconcile(store, client);
    expect(client.patchObject).toHaveBeenCalledTimes(1);

    // The member spends points. The ledger moves; Google does not yet.
    store.balances[`${TENANT}:${CUSTOMER_ID}`] = 500;
    client = fakeClient(objectWithBalance('96942'));

    const outcome = await reconcile(store, client);

    expect(outcome).toEqual({ kind: 'patched', objectId: OBJECT_ID, balancePoints: 500 });
    expect(client.patchObject).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// The balance is a projection of the ledger
// ============================================================================

describe('reconcilePass: the balance is read, never computed', () => {
  it('pushes exactly the number the ledger holds', async () => {
    store = readyStore({ balance: 742 });

    await reconcile(store, client);

    expect(client.patchObject).toHaveBeenCalledWith(OBJECT_ID, {
      loyaltyPoints: { label: CURRENCY, balance: { string: '742' } },
    });
  });

  it('reads the ledger through the tenant-scoped read, and sums nothing', async () => {
    // There is no arithmetic anywhere on this path. A `Math.max(0, …)` or a
    // `+ previous` here would be a second ledger, and the test that catches it
    // is a mutation of the read, not of any maths: the pushed string has to
    // equal the ledger's value for every value, including zero.
    for (const balance of [0, 1, 7, 1234567, BALANCE_DISPLAY_MAX]) {
      store = readyStore({ balance });
      // A balance the ledger can never hold, so the comparison is always a
      // difference and a patch is always attempted.
      client = fakeClient(objectWithBalance('not-a-real-balance'));

      await reconcile(store, client);

      expect(client.patchObject).toHaveBeenCalledWith(OBJECT_ID, {
        loyaltyPoints: { label: CURRENCY, balance: { string: String(balance) } },
      });
    }
  });

  it('compares against the balance Google actually holds, not against our last write', async () => {
    // `last_synced_at` records that we checked; it does not record what the
    // number was. Google is the only authority on what the pass shows, and
    // trusting our own bookkeeping would leave a pass that was edited or
    // reverted at Google permanently unfixed.
    client = fakeClient(objectWithBalance('4242'));
    store = readyStore({ pass: passRow({ state: 'issued', lastSyncedAt: OBSERVED_AT }) });

    const outcome = await reconcile(store, client);

    expect(outcome.kind).toBe('patched');
    expect(client.patchObject).toHaveBeenCalledTimes(1);
  });

  it('treats an object with no balance at all as a difference, not as agreement', async () => {
    // An object with no `loyaltyPoints` is one whose balance we have certainly
    // not projected onto. Shrugging and calling it in sync would record a pass
    // as correct that we have never seen the contents of.
    const bare = fakeObject();
    delete (bare as { loyaltyPoints?: unknown }).loyaltyPoints;
    client = fakeClient(bare);

    const outcome = await reconcile(store, client);

    expect(outcome.kind).toBe('patched');
    expect(client.patchObject).toHaveBeenCalledTimes(1);
  });

  it('pushes nothing when the balance is above what a pass can display', async () => {
    // `balance.ts` refuses to truncate rather than show a member `9999999`
    // when they hold 12345678. A truncated push is the same wrong number in a
    // new place.
    store = readyStore({ balance: BALANCE_DISPLAY_MAX + 1 });

    const outcome = await reconcile(store, client);

    expect(outcome).toEqual({
      kind: 'balance_not_displayable',
      points: BALANCE_DISPLAY_MAX + 1,
    });
    expect(client.patchObject).not.toHaveBeenCalled();
    // And the pass is not recorded as reconciled: it is now unverified, and
    // `last_synced_at` staying where it was is how that is visible.
    expect(store.reconciliations).toEqual([]);
  });

  it('accepts the balance exactly at the ceiling', async () => {
    store = readyStore({ balance: BALANCE_DISPLAY_MAX });
    client = fakeClient(objectWithBalance('1'));

    const outcome = await reconcile(store, client);

    expect(outcome.kind).toBe('patched');
    expect(client.patchObject).toHaveBeenCalledWith(OBJECT_ID, {
      loyaltyPoints: { label: CURRENCY, balance: { string: String(BALANCE_DISPLAY_MAX) } },
    });
  });
});

// ============================================================================
// The patch is the balance, and only the balance
// ============================================================================

describe('reconcilePass: what the patch contains', () => {
  it('sends the currency as well as the balance, so the patch is the same projection', async () => {
    // `label` is required inside `loyaltyPoints`, and the patch has to be the
    // shape the object was built with at issue time. A patch that disagreed
    // with the issued shape would be a second definition of the pass.
    await reconcile(store, client);

    const patch = client.patchObject.mock.calls[0]![1] as { loyaltyPoints: { label: string } };
    expect(patch.loyaltyPoints.label).toBe(CURRENCY);
  });

  it('leaves the name, the barcode and the tier row alone', async () => {
    // This matters more than it looks. Google documents that patching an array
    // replaces it wholesale, so a patch that rebuilt `textModulesData` would
    // drop the tier row rather than refresh it.
    await reconcile(store, client);

    const patch = client.patchObject.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(['loyaltyPoints']);
    expect(patch).not.toHaveProperty('accountName');
    expect(patch).not.toHaveProperty('barcode');
    expect(patch).not.toHaveProperty('textModulesData');
  });

  it('never changes the pass state, so it cannot activate or expire a pass', async () => {
    // Reconciliation is a balance projection, not a lifecycle controller.
    await reconcile(store, client);

    const patch = client.patchObject.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('state');
  });

  it('sends no notification preference, so a balance correction is not a push notification', async () => {
    // `notifyPreference` is transient: it has to be set on each request or no
    // notification fires, and Google caps update notifications at three per
    // pass per day. Reconciliation is a housekeeping write and stays one.
    await reconcile(store, client);

    const patch = client.patchObject.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('notifyPreference');
  });

  it('refuses to send a patch without a currency to label the balance with', async () => {
    // The same choice `issuePass` makes: an invented currency on a real pass is
    // a lie the member reads at the till.
    store = new FakeStore(
      { [TENANT]: programRow() },
      { [TENANT]: passRow() },
      { [`${TENANT}:${CUSTOMER_ID}`]: 96942 },
      { [TENANT]: null },
    );

    const outcome = await reconcile(store, fakeClient(objectWithBalance('0')));

    expect(outcome).toEqual({ kind: 'skipped_reason', reason: 'program_not_configured' });
  });
});

// ============================================================================
// Lifecycle states
// ============================================================================

describe('reconcilePass: a pass nobody is looking at', () => {
  /** `reconcile` fixes the clock, so the observation tests need their own. */
    function at(observedAt: Date) {
      return reconcilePass(
        { store, client, now: observedAt, demoMode: false },
        { tenantId: TENANT, customerId: CUSTOMER_ID },
      );
    }

  it('does not patch an object Google reports as not ACTIVE', async () => {
    // A non-ACTIVE pass is not being displayed, and Google may reject a patch
    // against an expired or completed object. Pushing to it would be a write
    // with no reader and a real chance of a 4xx.
    for (const state of ['INACTIVE', 'EXPIRED', 'COMPLETED', 'PENDING'] as const) {
      store = readyStore();
      client = fakeClient(fakeObject({ state }));

      const outcome = await reconcile(store, client);

      expect(outcome).toEqual({ kind: 'object_not_active', state, observationRecorded: true });
      expect(client.patchObject).not.toHaveBeenCalled();
    }
  });

  it('records no state for a non-ACTIVE object, so the pass is not called in sync', async () => {
    // "In sync" is a statement about a displayed number, and a pass nobody is
    // looking at is in agreement with nothing. So no `ReconciliationState` is
    // written — this is what keeps `not_saved` from being read as a claim that
    // the pass does not exist, and it is why the write that *does* happen is a
    // separate, state-free method.
    store = readyStore();
    client = fakeClient(fakeObject({ state: 'INACTIVE' }));

    await reconcile(store, client);

    expect(store.reconciliations).toEqual([]);
  });

  it('records the observation, so a non-ACTIVE pass leaves the sweep due set', async () => {
    // The liveness fix. The object exists and Google said so; that is a
    // definitive answer and `last_synced_at` is exactly the column that records
    // one. Without this the pass stays due for ever, is re-read on every run,
    // and — with enough of them in one tenant — starves the rest of it.
    store = readyStore();
    client = fakeClient(fakeObject({ state: 'PENDING' }));
    const observedAt = new Date('2026-09-28T06:00:00.000Z');

    const outcome = await at(observedAt);

    expect(store.observations).toHaveLength(1);
    expect(store.observations[0]).toEqual({
      customerId: CUSTOMER_ID,
      tenantId: TENANT,
      observedAt,
    });
    // And it is reported as recorded, so a caller tracking liveness can tell
    // "verified, nothing to claim" from "believed verified".
    expect(outcome).toEqual({
      kind: 'object_not_active',
      state: 'PENDING',
      observationRecorded: true,
    });
    expect(store.passes[TENANT]!.lastSyncedAt).toEqual(observedAt);
  });

  it('stamps the timestamp without touching the state, for every non-ACTIVE shape', async () => {
    // `INACTIVE` is what the sweep writes a lifecycle for; `PENDING` and
    // `STATE_UNSPECIFIED` are the shapes that have no mapping at all, and they
    // are the ones that used to be left completely alone. All five must move the
    // timestamp, and none may move the state.
    for (const state of ['INACTIVE', 'EXPIRED', 'COMPLETED', 'PENDING', 'STATE_UNSPECIFIED'] as const) {
      store = readyStore();
      client = fakeClient(fakeObject({ state }));
      const before = store.passes[TENANT]!.state;

      await at(new Date('2026-09-28T06:00:00.000Z'));

      expect(store.passes[TENANT]!.state).toBe(before);
      expect(store.observations).toHaveLength(1);
    }
  });

  it('reports observationRecorded false when the row could not be stamped', async () => {
    // The row vanished between the read and the write. Rare, and permanent: the
    // pass is still in the due set next run, so a caller counting liveness has
    // to be able to see it rather than assume the write landed.
    store = readyStore();
    client = fakeClient(fakeObject({ state: 'PENDING' }));
    store.recordPassObservation = async () => 0;

    const outcome = await at(new Date());

    expect(outcome).toEqual({
      kind: 'object_not_active',
      state: 'PENDING',
      observationRecorded: false,
    });
  });

  it('stamps a terminal row, which the rank guard used to discard entirely', async () => {
    // A row this worker itself moved to `expired`, whose object is ACTIVE and
    // whose balance already matches the ledger's. The rank guard matched no rows
    // at all, so the definitive answer was thrown away and the pass never left
    // the due set — the same starvation, reached by a different route.
    store = readyStore();
    store.passes[TENANT]!.state = 'expired';
    store.passes[TENANT]!.lastSyncedAt = new Date('2026-08-01T00:00:00.000Z');
    client = fakeClient(objectWithBalance('96942'));
    const observedAt = new Date('2026-09-28T06:00:00.000Z');

    const outcome = await at(observedAt);

    expect(outcome.kind).toBe('in_sync');
    // The claim was refused — `expired` is terminal — but the observation moved.
    expect(store.passes[TENANT]!.state).toBe('expired');
    expect(store.passes[TENANT]!.lastSyncedAt).toEqual(observedAt);
  });

  it('brings the balance forward once the pass is ACTIVE again', async () => {
    // The same object, first not active and then active. A pass that was
    // skipped for being inactive is not left behind by that skip.
    client = fakeClient(objectWithBalance('0', { state: 'INACTIVE' }));
    expect((await reconcile(store, client)).kind).toBe('object_not_active');

    const active = fakeClient(objectWithBalance('0', { state: 'active' }));
    const outcome = await reconcile(store, active);

    expect(outcome.kind).toBe('patched');
    expect(active.patchObject).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Class readiness
// ============================================================================

describe('reconcilePass: a class that cannot back a pass', () => {
  it('asks nothing of Google and writes nothing for an unapproved class', async () => {
    for (const reviewStatus of ['draft', 'under_review', 'rejected', 'none']) {
      store = readyStore({ program: programRow({ reviewStatus }) });
      client = fakeClient(fakeObject());

      const outcome = await reconcile(store, client);

      expect(outcome).toMatchObject({ kind: 'skipped', reason: 'class_not_approved' });
      expect(client.getObject).not.toHaveBeenCalled();
      expect(client.patchObject).not.toHaveBeenCalled();
      expect(store.reconciliations).toEqual([]);
    }
  });

  it('does not touch a tenant with no class row at all', async () => {
    store = readyStore({ program: null });

    const outcome = await reconcile(store, client);

    expect(outcome).toMatchObject({
      kind: 'skipped',
      reason: 'class_not_provisioned',
      reasonCode: 'WALLET_CLASS_NOT_PROVISIONED',
    });
    expect(client.getObject).not.toHaveBeenCalled();
  });

  it('does not touch a tenant whose stored class id is a mismatch', async () => {
    store = readyStore({ program: programRow({ classId: `${ISSUER}.tenant-somewhere-else` }) });

    const outcome = await reconcile(store, client);

    expect(outcome).toMatchObject({
      kind: 'skipped',
      reason: 'class_id_mismatch',
      reasonCode: 'WALLET_CLASS_ID_MISMATCH',
    });
    expect(client.patchObject).not.toHaveBeenCalled();
  });

  it('reuses classReadinessFor rather than re-deciding what a usable class is', async () => {
    // The reason code is carried out of the outcome, so a caller does not have
    // to re-derive the vocabulary the pass route would have used.
    store = readyStore({ program: programRow({ reviewStatus: 'draft' }) });

    const outcome = await reconcile(store, client);

    expect(outcome).toMatchObject({ reasonCode: 'WALLET_CLASS_NOT_APPROVED' });
  });
});

// ============================================================================
// Tenant scoping
// ============================================================================

describe('reconcilePass: tenant scoping', () => {
  it('touches exactly one tenant, and it is the one it was given', async () => {
    await reconcile(store, client);

    expect(store.tenantsTouched()).toEqual([TENANT]);
  });

  it('reads the pass row with the tenant named, not the row\'s own tenant', async () => {
    // A row whose `tenant_id` belongs to somebody else is a miss, not a hit. The
    // fake enforces that the way the SQL predicate does, so this fails if the
    // tenant is dropped from the read.
    store = new FakeStore(
      { [TENANT]: programRow() },
      { [TENANT]: passRow({ tenantId: OTHER_TENANT }) },
      { [`${TENANT}:${CUSTOMER_ID}`]: 96942 },
      { [TENANT]: CURRENCY },
    );

    const outcome = await reconcile(store, client);

    expect(outcome).toEqual({ kind: 'no_tracking_row' });
    expect(client.getObject).not.toHaveBeenCalled();
  });

  it('reads the ledger balance through the requested tenant', async () => {
    // The ledger is read per tenant. Another tenant's balance is not this
    // customer's balance, even for the same person.
    store = new FakeStore(
      { [TENANT]: programRow() },
      { [TENANT]: passRow() },
      { [`${OTHER_TENANT}:${CUSTOMER_ID}`]: 12345 },
      { [TENANT]: CURRENCY },
    );

    await reconcile(store, client);

    const balanceCall = store.calls.find((call) => call.method === 'latestBalance');
    expect(balanceCall?.tenantId).toBe(TENANT);
  });

  it('will not reconcile a customer of another business', async () => {
    store = readyStore({ pass: passRow({ customerId: OTHER_CUSTOMER_ID }) });

    const outcome = await reconcile(store, client);

    expect(outcome).toEqual({ kind: 'no_tracking_row' });
    expect(client.patchObject).not.toHaveBeenCalled();
  });

  it('re-derives readiness from the requested tenant, so a foreign class id is a mismatch', async () => {
    // The second layer. `classReadinessFor` derives the expected class id from
    // the tenant it was *asked about*, so a row whose `class_id` was derived for
    // a different tenant can never authorise a write. Deriving from
    // `program.tenantId` instead would accept it, which is the mutation this
    // test exists to catch.
    store = readyStore({
      program: programRow({ tenantId: OTHER_TENANT, classId: classIdFor(ISSUER, OTHER_TENANT) }),
    });

    const outcome = await reconcile(store, client);

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'class_id_mismatch' });
    expect(client.getObject).not.toHaveBeenCalled();
  });

  it('records the observation against the tenant it reconciled', async () => {
    await reconcile(store, client);

    expect(store.reconciliations[0]!.tenantId).toBe(TENANT);
  });
});

// ============================================================================
// Post-condition
// ============================================================================

describe('reconcilePass: a patch that provably did not apply', () => {
  it('raises rather than recording a pass as reconciled', async () => {
    // Google echoes the stored resource, so this is a free confirmation. A
    // silent no-op would leave a pass permanently wrong with a `last_synced_at`
    // claiming it was just verified.
    client.patchObject = vi.fn(async () =>
      objectWithBalance('0'),
    );

    await expect(reconcile(store, client)).rejects.toThrow(PassPatchNotAppliedError);
    expect(store.reconciliations).toEqual([]);
  });

  it('names the number it expected and the number that came back', async () => {
    client.patchObject = vi.fn(async () =>
      objectWithBalance('0'),
    );

    await expect(reconcile(store, client)).rejects.toThrow(
      /96942[\s\S]*"0"|"0"[\s\S]*96942/,
    );
  });

  it('is raised rather than swallowed, because it is a projection bug and not a bad minute', async () => {
    // The route swallows reconciliation failures because a Google outage must
    // not fail a pass request. That reasoning does not extend to this: a patch
    // that did not carry our number is a defect in the code above it, and it
    // is louder here than in a log line nobody reads.
    client.patchObject = vi.fn(async () => objectWithBalance('0'));

    const error = await reconcile(store, client).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PassPatchNotAppliedError);
    expect((error as PassPatchNotAppliedError).objectId).toBe(OBJECT_ID);
  });
});
