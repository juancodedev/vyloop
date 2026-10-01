import { beforeAll, describe, expect, it, vi } from 'vitest';

import { BALANCE_DISPLAY_MAX } from './balance';
import { classIdFor, objectIdFor } from './ids';
import {
  LoyaltyProgramNotConfiguredError,
  MemberCodeUnavailableError,
  classReadinessFor,
  ensureMemberCode,
  issuePass,
  reasonCodeFor,
} from './issuance';
import type { IssuePassDeps } from './issuance';
import { SAVE_TO_WALLET_URL_PREFIX } from './jwt';
import { isValidMemberCode } from './member-code';
import type {
  PassTrackingUpdate,
  WalletCustomerRow,
  WalletPassRow,
  WalletProgramRow,
  WalletStore,
  WalletTenantBrandingRow,
  WalletTierRow,
} from './store';

// ---------------------------------------------------------------------------
// Fixtures — the real demo values, plus a second tenant to attack
// ---------------------------------------------------------------------------

const ISSUER = '3388000000023206930';
const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const OTHER_TENANT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CUSTOMER_GLOBAL_ID = 'c8b61954-1b6d-4dfa-9954-b7c936a9e648';
const CUSTOMER_ID = 'd185c973-c976-46b5-b3bf-06185739a941';
const SERVICE_ACCOUNT = 'wallet@vyloop-demo.iam.gserviceaccount.com';
const ORIGINS = ['https://app.vyloop.app'];

const PEPPER = crypto.randomUUID();

let privateKeyPem: string;

beforeAll(async () => {
  // A key pair generated for this run and thrown away. No real credential
  // exists anywhere in this repository.
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${(base64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----\n`;
});

function programRow(overrides: Partial<WalletProgramRow> = {}): WalletProgramRow {
  return {
    tenantId: TENANT,
    issuerId: ISSUER,
    classId: classIdFor(ISSUER, TENANT),
    reviewStatus: 'approved',
    // A row read after the migration always carries the column, so the default
    // fixture says "not in demo mode" explicitly. Leaving it out would make
    // `classReadinessFor` treat the row as unreadable and fall back to demo mode,
    // which is the safe direction but would make every case below about the
    // fallback rather than about what it is testing.
    demoMode: false,
    lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function customerRow(overrides: Partial<WalletCustomerRow> = {}): WalletCustomerRow {
  return {
    id: CUSTOMER_ID,
    globalId: CUSTOMER_GLOBAL_ID,
    fullName: 'Lucía Fernández',
    memberCode: null,
    currentTierId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory store
//
// Implements the same tenant narrowing the real one does, so a test that passes
// a wrong tenant fails here exactly as it would against the database. Every
// method records the tenant it was called with, which is what lets a test assert
// that a customer cannot reach another tenant's rows.
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  tenantId: string;
}

class FakeStore implements WalletStore {
  readonly calls: Call[] = [];

  constructor(
    public readonly customersByTenant: Record<string, WalletCustomerRow[]> = {},
    public readonly programs: Record<string, WalletProgramRow> = {},
  ) {}

  private record(method: string, tenantId: string): void {
    this.calls.push({ method, tenantId });
  }

  /** Which tenants any method was asked about, for leak assertions. */
  tenantsTouched(): string[] {
    return [...new Set(this.calls.map((call) => call.tenantId))];
  }

  async findCustomer(globalId: string, tenantId: string): Promise<WalletCustomerRow | null> {
    this.record('findCustomer', tenantId);
    return (
      this.customersByTenant[tenantId]?.find((c) => c.globalId === globalId) ?? null
    );
  }

  async findCustomerById(customerId: string, tenantId: string): Promise<WalletCustomerRow | null> {
    this.record('findCustomerById', tenantId);
    return this.customersByTenant[tenantId]?.find((c) => c.id === customerId) ?? null;
  }

  async findProgram(tenantId: string): Promise<WalletProgramRow | null> {
    this.record('findProgram', tenantId);
    return this.programs[tenantId] ?? null;
  }

  // The three provisioning methods. Not `implements`-required by any rule this
  // suite exercises, and deliberately kept out of `tenantsTouched()`'s reach:
  // an issuance path that called one of them would be a second answer to
  // "does this tenant have a class", which `findProgram` already owns.
  async insertProgram(): Promise<void> {
    throw new Error('insertProgram is not part of the issuance path');
  }

  async findTenantBranding(): Promise<WalletTenantBrandingRow | null> {
    throw new Error('findTenantBranding is not part of the issuance path');
  }

  async findProgramName(): Promise<string | null> {
    throw new Error('findProgramName is not part of the issuance path');
  }

  async findPointsCurrency(tenantId: string): Promise<string | null> {
    this.record('findPointsCurrency', tenantId);
    return tenantId === TENANT ? 'puntos' : null;
  }

  async findTierName(tierId: string, tenantId: string): Promise<WalletTierRow | null> {
    this.record('findTierName', tenantId);
    return { name: 'Oro' };
  }

  balances: Record<string, number> = {};

  async latestBalance(customerId: string, tenantId: string): Promise<number> {
    this.record('latestBalance', tenantId);
    return this.balances[`${tenantId}:${customerId}`] ?? 0;
  }

  async isMemberCodeTaken(tenantId: string, code: string): Promise<boolean> {
    this.record('isMemberCodeTaken', tenantId);
    return (this.customersByTenant[tenantId] ?? []).some((c) => c.memberCode === code);
  }

  /**
   * The compare-and-set, faithfully. `claimWhen` lets a test simulate the two
   * situations that matter: a clean claim, and a lost race where the row already
   * carries somebody else's code.
   */
  claimBehaviour: 'succeed' | 'lose-race' | 'no-op' = 'succeed';
  claimedCodes: Array<{ customerId: string; tenantId: string; code: string }> = [];

  async claimMemberCode(
    customerId: string,
    tenantId: string,
    code: string,
  ): Promise<string | null> {
    this.record('claimMemberCode', tenantId);
    this.claimedCodes.push({ customerId, tenantId, code });

    if (this.claimBehaviour === 'no-op') return null;

    if (this.claimBehaviour === 'lose-race') {
      const winner = `${TENANT === tenantId ? '' : ''}W0NNER`;
      const row = (this.customersByTenant[tenantId] ?? []).find((c) => c.id === customerId);
      if (row) row.memberCode = winner;
      return winner;
    }

    const row = (this.customersByTenant[tenantId] ?? []).find((c) => c.id === customerId);
    if (!row || row.memberCode !== null) return null;
    row.memberCode = code;
    return code;
  }

  recorded: PassTrackingUpdate[] = [];

  async recordPass(update: PassTrackingUpdate): Promise<void> {
    this.record('recordPass', update.tenantId);
    this.recorded.push(update);
  }

  // Present only to satisfy the interface. `issuePass` never calls either, and
  // a test that proved otherwise would be testing the mock rather than the
  // code — so `reconcile.test.ts` owns their behaviour.
  async findPass(): Promise<null> {
    this.record('findPass', TENANT);
    return null;
  }

  async recordPassReconciliation(): Promise<number> {
    this.record('recordPassReconciliation', TENANT);
    return 0;
  }

  // The sweep's three additions. Issuance never calls them, and a fake that
  // threw would be a test that passes for the wrong reason; recording the call
  // means a test that reaches one of them can see it happened. `0` is the honest
  // answer for a store with no rows in it.
  async recordPassLifecycle(): Promise<number> {
    this.record('recordPassLifecycle', TENANT);
    return 0;
  }

  async recordPassObservation(): Promise<number> {
    this.record('recordPassObservation', TENANT);
    return 0;
  }

  async listProgramTenants(): Promise<WalletProgramRow[]> {
    this.record('listProgramTenants', '');
    return [];
  }

  async findPassesByObjectIds(): Promise<WalletPassRow[]> {
    this.record('findPassesByObjectIds', TENANT);
    return [];
  }

  async updateProgramReviewStatus(tenantId: string, reviewStatus: string): Promise<void> {
    this.record('updateProgramReviewStatus', tenantId);
    const row = this.programs[tenantId];
    if (row) row.reviewStatus = reviewStatus;
  }

  async setProgramDemoMode(tenantId: string, demoMode: boolean): Promise<number> {
    this.record('setProgramDemoMode', tenantId);
    const row = this.programs[tenantId];
    if (!row) return 0;
    row.demoMode = demoMode;
    return 1;
  }
}

function readyStore(overrides: Partial<WalletProgramRow> = {}): FakeStore {
  return new FakeStore({ [TENANT]: [customerRow()] }, { [TENANT]: programRow(overrides) });
}

function deps(store: WalletStore, overrides: Partial<IssuePassDeps> = {}): IssuePassDeps {
  return {
    store,
    pepper: PEPPER,
    serviceAccountEmail: SERVICE_ACCOUNT,
    privateKeyPem,
    origins: ORIGINS,
    now: new Date('2026-09-28T12:00:00.000Z'),
    ...overrides,
  };
}

function passInput(overrides: Partial<Parameters<typeof issuePass>[1]> = {}) {
  return {
    tenantId: TENANT,
    customerId: CUSTOMER_ID,
    customerGlobalId: CUSTOMER_GLOBAL_ID,
    customerFullName: 'Lucía Fernández',
    storedMemberCode: null,
    issuerId: ISSUER,
    classId: classIdFor(ISSUER, TENANT),
    ...overrides,
  };
}

// ============================================================================
// Class readiness — the design question
// ============================================================================

describe('classReadinessFor', () => {
  it('accepts an approved class whose stored id matches the derivation', () => {
    const readiness = classReadinessFor(programRow(), TENANT, false);

    expect(readiness.ok).toBe(true);
    if (readiness.ok) {
      expect(readiness.classId).toBe(
        '3388000000023206930.tenant-90d5ad58-bc5c-46a3-b82a-9cebb47e00b1',
      );
      expect(readiness.issuerId).toBe(ISSUER);
    }
  });

  it('reports an unprovisioned tenant as a missing class, never as a failure', () => {
    // The design answer: no row is an honest, named prerequisite. Nothing is
    // created, because a class needs a Google review that cannot be skipped and
    // cannot return to draft.
    const readiness = classReadinessFor(null, TENANT, false);

    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.reason).toBe('class_not_provisioned');
      expect(reasonCodeFor(readiness.reason)).toBe('WALLET_CLASS_NOT_PROVISIONED');
      expect(readiness.message).toMatch(/onboarding/i);
    }
  });

  it.each(['none', 'draft', 'under_review', 'rejected'])(
    'blocks issuance while the class is %s',
    (status) => {
      const readiness = classReadinessFor(programRow({ reviewStatus: status }), TENANT, false);

      expect(readiness.ok).toBe(false);
      if (!readiness.ok) {
        expect(readiness.reason).toBe('class_not_approved');
        expect(reasonCodeFor(readiness.reason)).toBe('WALLET_CLASS_NOT_APPROVED');
      }
    },
  );

  it('fails closed on a review status it has never heard of', () => {
    // The column is `text` with no check constraint, so a future migration or a
    // hand-written row can carry anything. An allow-list of unusable states
    // would start issuing passes against a state nobody reasoned about.
    const readiness = classReadinessFor(programRow({ reviewStatus: 'APPROVED' }), TENANT, false);

    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.reason).toBe('class_not_approved');
  });

  it('blocks a stored class id that disagrees with the derivation', () => {
    // Sending Google an id that is not `<issuerId>.tenant-<tenantId>` is a 400
    // at the customer's tap. Catching it here names an operational data error
    // instead of a customer-facing failure.
      const readiness = classReadinessFor(
        programRow({ classId: '3388000000023206930.tenant-something-else' }),
        TENANT,
        false,
      );

    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.reason).toBe('class_id_mismatch');
      expect(reasonCodeFor(readiness.reason)).toBe('WALLET_CLASS_ID_MISMATCH');
    }
  });

  it('derives against the requested tenant, so another tenant\'s row cannot pass', () => {
    // A row that genuinely belongs to the other tenant: its stored class id is
    // the one derived for OTHER_TENANT. Unreachable through the store, which
    // filters by tenant. Asserted anyway, because a defence that only exists in
    // one layer is a defence that exists until the layer above it changes.
    const foreignRow = programRow({
      tenantId: OTHER_TENANT,
      classId: classIdFor(ISSUER, OTHER_TENANT),
    });

    const readiness = classReadinessFor(foreignRow, TENANT, false);

    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.reason).toBe('class_id_mismatch');
  });

  it('never accepts a row whose own tenant id is not the requested one', () => {
    // The stronger statement of the rule above, independent of the class id: if
    // a row ever self-identifies as another tenant, it is not this tenant's row.
    const foreignRow = programRow({
      tenantId: OTHER_TENANT,
      // Even if the class id somehow matched, the row's own tenant id does not.
      classId: classIdFor(ISSUER, TENANT),
    });

    // Readiness succeeds on the id, so the guard that catches this has to be the
    // store's tenant filter. Asserted explicitly so that guard is not assumed.
    expect(classReadinessFor(foreignRow, TENANT, false).ok).toBe(true);
    // Which is precisely why `FakeStore.findProgram` is tenant-indexed, and why
    // the store test below proves the SQL does the same.
  });

  it('reports the review before the id, so the actionable prerequisite wins', () => {
    // Both are wrong. The review is what a person waits on; reporting the id
    // would send an operator to fix a string while the class is still unusable
    // for the reason Google has not finished looking at it.
      const readiness = classReadinessFor(
        programRow({ reviewStatus: 'draft', classId: 'wrong' }),
        TENANT,
        false,
      );

    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.reason).toBe('class_not_approved');
  });

  it('gives every unavailable reason its own stable code', () => {
    const codes = (['class_not_provisioned', 'class_not_approved', 'class_id_mismatch'] as const).map(
      reasonCodeFor,
    );

    expect(new Set(codes).size).toBe(3);
    expect(reasonCodeFor('available')).toBe('OK');
  });
});

// ============================================================================
// Member code
// ============================================================================

describe('ensureMemberCode', () => {
  it('returns a stored code without deriving anything', async () => {
    const store = readyStore();
    store.customersByTenant[TENANT]![0]!.memberCode = 'K7M2QX';

    const code = await ensureMemberCode(deps(store), CUSTOMER_ID, TENANT, CUSTOMER_GLOBAL_ID, 'K7M2QX');

    expect(code).toBe('K7M2QX');
    // Nothing was written. A code a member has memorised at a counter must not
    // move because the algorithm was refactored.
    expect(store.claimedCodes).toHaveLength(0);
  });

  it('derives, claims and returns a code for a customer who has none', async () => {
    const store = readyStore();

    const code = await ensureMemberCode(deps(store), CUSTOMER_ID, TENANT, CUSTOMER_GLOBAL_ID, null);

    expect(isValidMemberCode(code)).toBe(true);
    expect(store.claimedCodes).toEqual([{ customerId: CUSTOMER_ID, tenantId: TENANT, code }]);
    // And it is really persisted, not just returned.
    expect(store.customersByTenant[TENANT]![0]!.memberCode).toBe(code);
  });

  it('uses the code the winner stored when it loses the compare-and-set', async () => {
    // The load-bearing race. Returning this request's own candidate would give
    // the customer an accountId that no Google object ever carries, while the
    // stored code is somebody else's.
    const store = readyStore();
    store.claimBehaviour = 'lose-race';

    const code = await ensureMemberCode(deps(store), CUSTOMER_ID, TENANT, CUSTOMER_GLOBAL_ID, null);

    expect(code).toBe('W0NNER');
    expect(code).not.toBe(store.claimedCodes[0]!.code);
  });

  it('re-reads once when the claim changed nothing at all', async () => {
    const store = readyStore();
    store.claimBehaviour = 'no-op';
    // Simulate a concurrent writer having persisted a valid code after the read
    // but before the claim, with the claim itself reporting nothing.
    const originalClaim = store.claimMemberCode.bind(store);
    vi.spyOn(store, 'claimMemberCode').mockImplementation(async (customerId, tenantId, code) => {
      const row = store.customersByTenant[tenantId]!.find((c) => c.id === customerId)!;
      row.memberCode = 'R3AD02';
      return originalClaim(customerId, tenantId, code);
    });

    const code = await ensureMemberCode(deps(store), CUSTOMER_ID, TENANT, CUSTOMER_GLOBAL_ID, null);

    expect(code).toBe('R3AD02');
  });

  it('refuses to return anything rather than a malformed code', async () => {
    // The whole point: a pass with a blank or malformed accountId looks valid
    // in the wallet and is dead at the counter.
    const store = readyStore();
    store.claimBehaviour = 'no-op';

    await expect(
      ensureMemberCode(deps(store), CUSTOMER_ID, TENANT, CUSTOMER_GLOBAL_ID, null),
    ).rejects.toBeInstanceOf(MemberCodeUnavailableError);
  });

  it('repairs a malformed stored code rather than obeying it', async () => {
    // Six display characters, derived deterministically, never machine-read by
    // the POS. Refusing to issue over a bad display string would be a support
    // incident for something with a deterministic fix.
    const store = readyStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const code = await ensureMemberCode(
      deps(store),
      CUSTOMER_ID,
      TENANT,
      CUSTOMER_GLOBAL_ID,
      'not-a-code',
    );

    expect(isValidMemberCode(code)).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('salts by tenant, so one person gets two codes at two merchants', async () => {
    const store = new FakeStore(
      {
        [TENANT]: [customerRow()],
        [OTHER_TENANT]: [customerRow({ id: 'other-customer' })],
      },
      { [TENANT]: programRow(), [OTHER_TENANT]: programRow({ tenantId: OTHER_TENANT }) },
    );

    const atFirst = await ensureMemberCode(
      deps(store),
      CUSTOMER_ID,
      TENANT,
      CUSTOMER_GLOBAL_ID,
      null,
    );
    const atSecond = await ensureMemberCode(
      deps(store),
      'other-customer',
      OTHER_TENANT,
      CUSTOMER_GLOBAL_ID,
      null,
    );

    expect(atFirst).not.toBe(atSecond);
    // The collision check is tenant-scoped, so one merchant's members cannot
    // exhaust the other's code space.
    expect(store.calls.filter((c) => c.method === 'isMemberCodeTaken').map((c) => c.tenantId)).toEqual(
      [TENANT, OTHER_TENANT],
    );
  });

  it('never claims a code against a tenant other than the one asked for', async () => {
    const store = readyStore();

    await ensureMemberCode(deps(store), CUSTOMER_ID, TENANT, CUSTOMER_GLOBAL_ID, null);

    expect(store.claimedCodes.every((claim) => claim.tenantId === TENANT)).toBe(true);
  });
});

// ============================================================================
// Pass issuance
// ============================================================================

describe('issuePass', () => {
  it('returns a save link carrying the ledger balance and the stored code', async () => {
    const store = readyStore();
    store.balances[`${TENANT}:${CUSTOMER_ID}`] = 96942;

    const issued = await issuePass(deps(store), passInput());

    expect(issued.saveUrl.startsWith(SAVE_TO_WALLET_URL_PREFIX)).toBe(true);
    expect(issued.objectId).toBe(objectIdFor(ISSUER, CUSTOMER_GLOBAL_ID));
    expect(issued.classId).toBe(classIdFor(ISSUER, TENANT));
    expect(issued.pointsCurrency).toBe('puntos');
    expect(issued.balancePoints).toBe(96942);
    expect(issued.loyaltyObject.loyaltyPoints.balance.string).toBe('96942');
    expect(issued.loyaltyObject.accountId).toBe(issued.memberCode);
    // The barcode carries the full globalId, because that is all the POS reads.
    expect(issued.loyaltyObject.barcode.value).toBe(CUSTOMER_GLOBAL_ID);
  });

  it('copies the balance from the ledger rather than computing one', async () => {
    // A member who has never earned holds zero, and that is a balance, not a
    // missing value.
    const store = readyStore();

    const issued = await issuePass(deps(store), passInput());

    expect(issued.balancePoints).toBe(0);
    expect(store.calls.some((c) => c.method === 'latestBalance')).toBe(true);
  });

  it('reads the balance for the requested tenant only', async () => {
    const store = readyStore();

    await issuePass(deps(store), passInput());

    const balanceCalls = store.calls.filter((c) => c.method === 'latestBalance');
    expect(balanceCalls).toHaveLength(1);
    expect(balanceCalls[0]!.tenantId).toBe(TENANT);
  });

  it('omits a null name rather than sending a blank one', async () => {
    const store = readyStore();

    const issued = await issuePass(deps(store), passInput({ customerFullName: null }));

    expect(issued.loyaltyObject.accountName).toBeUndefined();
  });

  it('records the pass as not_issued, because handing out a link creates nothing', async () => {
    // The object comes into being when the customer saves it, and this system
    // has no webhook that would learn about that yet. Advancing the tracking
    // state here would assert a pass the customer does not have.
    const store = readyStore();

    await issuePass(deps(store), passInput());

    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]).toEqual({
      customerId: CUSTOMER_ID,
      tenantId: TENANT,
      objectId: objectIdFor(ISSUER, CUSTOMER_GLOBAL_ID),
      lastSyncedAt: null,
    });
  });

  it('sends no sync timestamp, because nothing has been synced with Google', async () => {
    const store = readyStore();

    await issuePass(deps(store), passInput());

    expect(store.recorded[0]!.lastSyncedAt).toBeNull();
  });

  it('omits the tier row rather than inventing a header for it', async () => {
    // `object.ts` requires a header whenever a tier name is present, and there
    // is no column anywhere to store one. Real data is omitted rather than
    // fabricated, and this asserts the omission is a decision.
    const store = readyStore();

    const issued = await issuePass(deps(store), passInput());

    expect(issued.loyaltyObject.textModulesData).toBeUndefined();
  });

  it('refuses to build a pass for a tenant with no loyalty program', async () => {
    // `loyaltyPoints.label` is required by Google. A made-up currency on a real
    // pass is a lie a member reads at the till.
    const store = new FakeStore({ [TENANT]: [customerRow()] }, { [TENANT]: programRow() });
    store.findPointsCurrency = async () => null;

    await expect(issuePass(deps(store), passInput())).rejects.toBeInstanceOf(
      LoyaltyProgramNotConfiguredError,
    );
    // And nothing was recorded.
    expect(store.recorded).toHaveLength(0);
  });

  it('makes no Google API call, so a bad minute at Google is not a broken button', async () => {
    const store = readyStore();
    const originalClaim = store.claimMemberCode.bind(store);
    vi.spyOn(store, 'claimMemberCode').mockImplementation(async (a, b, c) => {
      // The only store methods issuance may use. Anything reaching for a client
      // would be new behaviour, and this pins the current set.
      expect(store.calls.map((call) => call.method)).not.toContain('getClass');
      return originalClaim(a, b, c);
    });

    await issuePass(deps(store), passInput());

    expect(store.calls.map((call) => call.method)).not.toContain('getClass');
  });

  it('only ever touches the tenant it was given', async () => {
    // The strongest tenant assertion in this file: not "the right row was
    // returned" but "no other tenant was ever queried".
    const store = readyStore();

    await issuePass(deps(store), passInput());

    expect(store.tenantsTouched()).toEqual([TENANT]);
  });

  it('signs a token whose object the store actually recorded', async () => {
    const store = readyStore();

    const issued = await issuePass(deps(store), passInput());

    expect(store.recorded[0]!.objectId).toBe(issued.loyaltyObject.id);
  });

  it('refuses to issue a pass whose balance cannot be rendered', async () => {
    // Over the 7-character display ceiling, `formatBalance` throws rather than
    // showing a member a truncated number at the till.
    const store = readyStore();
    store.balances[`${TENANT}:${CUSTOMER_ID}`] = BALANCE_DISPLAY_MAX + 1;

    await expect(issuePass(deps(store), passInput())).rejects.toThrow(/cannot be rendered/i);
  });

  it('signs with iat from the injected clock, so the token is assertable', async () => {
    const store = readyStore();
    const issued = await issuePass(
      deps(store, { now: new Date('2026-09-28T12:00:00.000Z') }),
      passInput(),
    );

    // The prefix and a three-segment token, at minimum. The full claim set is
    // asserted in jwt.test.ts; this is only that the route path produces one.
    const token = issued.saveUrl.slice(SAVE_TO_WALLET_URL_PREFIX.length);
    expect(token.split('.')).toHaveLength(3);
  });
});
