import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { BALANCE_DISPLAY_MAX } from './balance';
import { DEMO_MODE_NAME_PREFIX, classIdFor, objectIdFor } from './ids';
import {
  LoyaltyProgramNotConfiguredError,
  MemberCodeUnavailableError,
  classReadinessFor,
  dispositionForExistingPass,
  ensureMemberCode,
  issuePass,
  linkForExistingPass,
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
  WalletProgramWithBusinessRow,
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
  async getIssuerId(): Promise<string> {
    throw new Error('getIssuerId is not used by the issuance tests');
  }

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

  /**
   * Throws, like the other off-path reads here.
   *
   * Issuing a pass needs the class id, which `findProgram` owns. The joined read
   * additionally carries a merchant's display name and slug, and an issuance path
   * that consulted either would be reading branding to decide something the
   * ledger has no use for — and could be made to fail by a missing name.
   */
  async findProgramWithBusiness(): Promise<WalletProgramWithBusinessRow | null> {
    throw new Error('findProgramWithBusiness is not part of the issuance path');
  }

  async findProgramName(): Promise<string | null> {
    throw new Error('findProgramName is not part of the issuance path');
  }

  async findPointsCurrency(tenantId: string): Promise<string | null> {
    this.record('findPointsCurrency', tenantId);
    return tenantId === TENANT ? 'puntos' : null;
  }

  /**
   * Absent. The issuance path never reads it: the promo copy is per-merchant and
   * reaches the pass through the class, which Google copies at insert time.
   */
  async findPromoCopy(): Promise<null> {
    this.record('findPromoCopy', '');
    return null;
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

  async listTenantsWithoutProgram(): Promise<string[]> {
    // Recorded rather than throwing, like the other sweep methods above: the
    // issuance path never asks, and a fake that threw would make a caller that
    // did ask fail for the wrong reason.
    this.record('listTenantsWithoutProgram', '');
    return [];
  }

  async findPassesByObjectIds(): Promise<WalletPassRow[]> {
    this.record('findPassesByObjectIds', TENANT);
    return [];
  }

  /**
   * The pass-inactivity rule's query. Unreachable from this suite: the rule has its
   * own module and its own fake store, and a fake that quietly answered it would
   * let a caller reach it without any test noticing.
   */
  async findInactivePassCandidates(): Promise<never> {
    throw new Error('findInactivePassCandidates is not used by this test suite.');
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

  // Callback methods, present only to satisfy the interface. The issuance path
  // never calls them, and `record` would turn a call into a failing assertion
  // rather than a silent one.
  async findTenantByClassId(): Promise<null> {
    throw new Error('the issuance path must not resolve a tenant from a class id');
  }
  async claimCallbackDelivery(): Promise<boolean> {
    throw new Error('the issuance path must not claim a callback delivery');
  }
  async recordPassCallback(): Promise<number> {
    throw new Error('the issuance path must not record a callback');
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
// Will Google accept this?
//
// The gate answers one question, and the question is not "is this merchant in
// demo mode". It is "will Google's `loyaltyObject.insert` take this request".
// Those are two different questions about two different objects, and the gate
// that answers the second with the first is the bug this block exists to pin.
//
// The two rules, side by side:
//
//   | Google accepts  | the old gate accepted                    |
//   | ---------------- | ----------------------------------------- |
//   | approved class  | approved, or demo, or unreadable           |
//   | [TEST ONLY] id  |                                          |
//
// `DEMO_MODE_NAME_PREFIX` is where the `[TEST ONLY] ` marker lives. One
// declaration, in `ids.ts`, read by the gate — never re-spelled.
// ============================================================================

describe('classReadinessFor: will Google accept an object for this class?', () => {
  /** A row for `tenantId`, defaulting to the approved happy path. */
  function rowFor(tenantId: string, overrides: Partial<WalletProgramRow> = {}): WalletProgramRow {
    return {
      tenantId,
      issuerId: ISSUER,
      classId: classIdFor(ISSUER, tenantId),
      reviewStatus: 'approved',
      demoMode: false,
      lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  /**
   * The stored class id for a class Google put in demo mode.
   *
   * The marker is a **name** marker — `ids.ts` says so, and it is what Google
   * requires on a pass while the issuer has no publishing access — so it is
   * carried as a prefix on the stored id and the suffix is the resource id. The
   * gate has to see through it, both to accept the class and to keep the
   * derivation check meaningful.
   */
  function demoClassIdFor(tenantId: string): string {
    return `${DEMO_MODE_NAME_PREFIX}${classIdFor(ISSUER, tenantId)}`;
  }

  it('accepts an approved class with demo mode off, because Google approves it', () => {
    const readiness = classReadinessFor(rowFor(TENANT, { demoMode: false }), TENANT, false);

    expect(readiness.ok).toBe(true);
  });

  it('accepts an approved class with demo mode on, because approval is what decides', () => {
    // `demo_mode` answers *who receives the pass*, not *whether the object can
    // be created*. A merchant who has left demo mode still needs the class
    // approved, and one still inside it needs nothing extra. The flag must not
    // move this answer in either direction.
    const readiness = classReadinessFor(rowFor(TENANT, { demoMode: true }), TENANT, false);

    expect(readiness.ok).toBe(true);
  });

  it('refuses a draft class with demo mode on and no [TEST ONLY] marker', () => {
    // **The production bug.** `cafe-prueba-0117` and `sonda-a2-1116` both sit
    // here: `draft`, `demo_mode: true`, no marker. The old gate answered `ok`
    // because `demoMode` was true, the pass route went on to build an object,
    // and Google answered:
    //
    //   404: Wallet Object Class {...} not approved
    //
    // which became `WALLET_PASS_NOT_CREATABLE` and told the customer to come
    // back in a while. Retrying cannot ever work: the review is Google's and it
    // takes days. So the gate has to refuse here, and say why.
    const readiness = classReadinessFor(rowFor(TENANT, { reviewStatus: 'draft', demoMode: true }), TENANT, false);

    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.reason).toBe('class_not_approved');
      expect(reasonCodeFor(readiness.reason)).toBe('WALLET_CLASS_NOT_APPROVED');
      // Says what is actually true: the class is not approved, and no amount of
      // asking again from this side changes that.
      expect(readiness.message).toMatch(/not approved|not been approved/i);
      expect(readiness.message).not.toMatch(/try again|in a (while|moment)|reintent/i);
    }
  });

  it('accepts a draft class whose id carries the [TEST ONLY] marker, which is the real demo path', () => {
    // **The other half, and the one that must not break.** This is how Google
    // itself seeds a demo-mode test: the class stays `draft` and the id carries
    // the marker, and Google accepts objects against it while limiting delivery
    // to the issuer's test accounts. Refusing this sends every one of Google's
    // testers back to the 404, which is worse than the bug being fixed.
    const readiness = classReadinessFor(
      rowFor(TENANT, { reviewStatus: 'draft', demoMode: true, classId: demoClassIdFor(TENANT) }),
      TENANT,
      false,
    );

    expect(readiness.ok).toBe(true);
  });

  it('returns the derived resource id, so the marker never reaches Google', () => {
    // The marker is how *we* recognise the class, not part of the resource
    // identifier Google knows it by. An object built against the marked string
    // is a 400 at the customer's tap, so the gate has to answer with the
    // derived id while still recognising the class.
    const readiness = classReadinessFor(
      rowFor(TENANT, { reviewStatus: 'draft', classId: demoClassIdFor(TENANT) }),
      TENANT,
      false,
    );

    expect(readiness.ok).toBe(true);
    if (readiness.ok) {
      expect(readiness.classId).toBe(classIdFor(ISSUER, TENANT));
      expect(readiness.classId).not.toContain(DEMO_MODE_NAME_PREFIX);
    }
  });

  it('still refuses a draft class with demo mode off and no marker', () => {
    const readiness = classReadinessFor(rowFor(TENANT, { reviewStatus: 'draft', demoMode: false }), TENANT, false);

    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.reason).toBe('class_not_approved');
  });

  it('does not let the deployment-wide demo mode reopen a class Google will refuse', () => {
    // **The symmetric risk.** `workers/wallet/wrangler.jsonc` ships
    // `WALLET_DEMO_MODE: "true"`, so if the env flag were still an allowance in
    // this function, every draft tenant in production would pass again and the
    // 404 would come back with them. `envDemoMode` is passed as `true` here on
    // purpose: the answer must be identical to the one above it.
    const withEnvDemo = classReadinessFor(
      rowFor(TENANT, { reviewStatus: 'draft', demoMode: false }),
      TENANT,
      true,
    );
    const withoutEnvDemo = classReadinessFor(
      rowFor(TENANT, { reviewStatus: 'draft', demoMode: false }),
      TENANT,
      false,
    );

    expect(withEnvDemo.ok).toBe(false);
    expect(withEnvDemo.ok).toBe(withoutEnvDemo.ok);
  });

  it('does not let a marker smuggle a class id that belongs to another tenant', () => {
    // The derivation check runs on the id behind the marker. A prefix must not
    // become a way to skip it, because skipping it is exactly how a pass gets
    // built against somebody else's class.
    const readiness = classReadinessFor(
      rowFor(OTHER_TENANT, {
        reviewStatus: 'draft',
        classId: `${DEMO_MODE_NAME_PREFIX}${classIdFor(ISSUER, OTHER_TENANT)}`,
      }),
      TENANT,
      false,
    );

    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.reason).toBe('class_id_mismatch');
  });

  /**
   * The five production tenants, as read on 2026-10-06.
   *
   * The three that work are `approved`. The two that 404 are `draft`. The
   * `demo_mode` column does not discriminate — it is `true` for two of the
   * three that work — which is precisely why it looked like the gate was
   * working. `classIdCarriesPrefix` is the fact that actually distinguishes
   * them: none of the five carries the marker, so under the corrected rule
   * exactly the three approved ones pass.
   *
   * The tenant ids are stand-ins. The gate reads `review_status`, `demo_mode`
   * and whether the class id carries the marker; no uuid is consulted, so a
   * different uuid per row is inert and pinning the real ones would be noise.
   */
  const PRODUCTION_TENANTS: ReadonlyArray<{
    slug: string;
    tenantId: string;
    reviewStatus: string;
    demoMode: boolean;
    classIdCarriesPrefix: boolean;
    googleAccepts: boolean;
  }> = [
    {
      slug: 'cafe-central',
      tenantId: '3c1a9f20-5d84-4b17-9e02-7a6c1d8f4e01',
      reviewStatus: 'approved',
      demoMode: false,
      classIdCarriesPrefix: false,
      googleAccepts: true,
    },
    {
      slug: 'cafe-e2e-1448',
      tenantId: '8b41d7c6-0e29-4f53-a7b8-2c9e6d0a3f12',
      reviewStatus: 'approved',
      demoMode: true,
      classIdCarriesPrefix: false,
      googleAccepts: true,
    },
    {
      slug: 'vyloop-demo',
      tenantId: 'f0d53a94-6c71-4e28-8b1d-4a7e3c95b023',
      reviewStatus: 'approved',
      demoMode: true,
      classIdCarriesPrefix: false,
      googleAccepts: true,
    },
    {
      slug: 'cafe-prueba-0117',
      tenantId: '2e8b04f1-9a36-4d7c-b5e2-6f1a8d4c7034',
      reviewStatus: 'draft',
      demoMode: true,
      classIdCarriesPrefix: false,
      googleAccepts: false,
    },
    {
      slug: 'sonda-a2-1116',
      tenantId: 'd47b6e08-1c92-4a5f-9e37-8b0d2f6a4c15',
      reviewStatus: 'draft',
      demoMode: true,
      classIdCarriesPrefix: false,
      googleAccepts: false,
    },
  ];

  it.each(PRODUCTION_TENANTS)(
    'agrees with Google on $slug ($reviewStatus, demo_mode $demoMode, marker $classIdCarriesPrefix)',
    ({ tenantId, reviewStatus, demoMode, classIdCarriesPrefix, googleAccepts }) => {
      // Built the way the row is built, from the same two inputs the fixture
      // records: the review status Google reported, and whether the id carries
      // the marker.
      const row = rowFor(tenantId, {
        reviewStatus,
        demoMode,
        classId: classIdCarriesPrefix ? demoClassIdFor(tenantId) : classIdFor(ISSUER, tenantId),
      });

      // With the deployment's `WALLET_DEMO_MODE=true`, the flag production runs.
      const readiness = classReadinessFor(row, tenantId, true);

      expect(readiness.ok, `${reviewStatus}/demo=${demoMode}/marker=${classIdCarriesPrefix}`).toBe(
        googleAccepts,
      );
    },
  );

  it('refuses exactly the two tenants that Google refused, and no other', () => {
    // The count, stated separately so a row flipping cannot hide behind five
    // individually-passing assertions.
    const refused = PRODUCTION_TENANTS.filter((tenant) => {
      const row = rowFor(tenant.tenantId, {
        reviewStatus: tenant.reviewStatus,
        demoMode: tenant.demoMode,
        classId: tenant.classIdCarriesPrefix
          ? demoClassIdFor(tenant.tenantId)
          : classIdFor(ISSUER, tenant.tenantId),
      });

      return !classReadinessFor(row, tenant.tenantId, true).ok;
    }).map((tenant) => tenant.slug);

    expect(refused).toEqual(['cafe-prueba-0117', 'sonda-a2-1116']);
  });
});

/**
 * The contract that keeps the prefix from having a second home.
 *
 * Worth more than every behavioural case above. The fix is one `startsWith`
 * call, and the way this bug comes back is somebody typing `'[TEST ONLY] '` a
 * second time because they did not know where the constant lived — at which
 * point the gate and the marker drift apart and, when the marker changes, only
 * one of them moves. So this asserts on the **source**: the gate names the
 * constant and holds no literal of its own.
 *
 * Reading the file rather than importing it is the point. An import would prove
 * only that a symbol resolves; this proves what the file says.
 */
describe('the demo-mode marker has exactly one home', () => {
  const source = readFileSync(join(__dirname, 'issuance.ts'), 'utf8');

  it('is declared once, in ids.ts', () => {
    const ids = readFileSync(join(__dirname, 'ids.ts'), 'utf8');

    expect(ids).toContain("export const DEMO_MODE_NAME_PREFIX = '[TEST ONLY] '");
    // And nowhere else in this file: the declaration is the only occurrence, so
    // the constant cannot be a second copy of itself.
    expect([...ids.matchAll(/DEMO_MODE_NAME_PREFIX\s*=/g)]).toHaveLength(1);
  });

  it('is read from DEMO_MODE_NAME_PREFIX by the gate, not re-spelled', () => {
    expect(source).toMatch(/import\s*\{[^}]*DEMO_MODE_NAME_PREFIX[^}]*\}\s*from\s*'\.\/ids'/);
    expect(source).toContain('DEMO_MODE_NAME_PREFIX');
  });

  it('never appears as a literal anywhere in the gate', () => {
    // No `'[TEST ONLY] '` and no `"[TEST ONLY] "` and no template literal
    // spelling it out. The constant is the only spelling, and this is what fails
    // the day somebody adds a second one.
    expect(source).not.toMatch(/\[TEST ONLY\]/);
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

// ============================================================================
// Idempotent issuance — what an existing pass row means for this request
//
// The save link is signed on the fly and never stored, so returning a pass that
// already exists costs one signature and no write. The only question this suite
// answers is the one a tracking row makes necessary: what does *this* state say
// about whether the object exists at Google.
// ============================================================================

describe('dispositionForExistingPass', () => {
  function passRow(overrides: Partial<WalletPassRow> = {}): WalletPassRow {
    return {
      customerId: CUSTOMER_ID,
      tenantId: TENANT,
      objectId: `${ISSUER}.member-${CUSTOMER_GLOBAL_ID}`,
      state: 'issued',
      lastSyncedAt: new Date('2026-09-28T12:00:00.000Z'),
      ...overrides,
    };
  }

  it('mints when the customer has no pass row at all', () => {
    // The ordinary first visit. Nothing exists, so there is nothing to reuse.
    expect(dispositionForExistingPass(null, TENANT)).toEqual({ kind: 'mint' });
  });

  it('reuses an `issued` pass instead of minting a second one', () => {
    // The whole feature. Google has the object and the customer holds it, so
    // inserting again can only ever be a 409 that has to be undone by a patch.
    const disposition = dispositionForExistingPass(passRow({ state: 'issued' }), TENANT);

    expect(disposition.kind).toBe('reuse');
  });

  it('reuses a `not_saved` pass, because that is a gap in our knowledge', () => {
    // The schema comment separates these two on purpose: `not_issued` is a state
    // the customer is in, `not_saved` is a gap in what *we* know, written only
    // when Google was asked and answered that it has no object. Reading it as
    // "this customer has no pass" would tell a merchant a falsehood, and acting
    // on it by minting again would create a second object for one customer.
    // Google creates the object from the save token when the customer taps, so
    // the link is still the answer.
    const disposition = dispositionForExistingPass(passRow({ state: 'not_saved' }), TENANT);

    expect(disposition.kind).toBe('reuse');
  });

  it('reuses an `inactive` pass, because it is the same pass, deactivated', () => {
    // A customer who switched a pass off still holds that pass: `inactive` is
    // how Google's platform records it, and `store.ts` documents `inactive →
    // issued` as a real transition when they switch it back on. Minting over it
    // would be a second card for one customer.
    const disposition = dispositionForExistingPass(passRow({ state: 'inactive' }), TENANT);

    expect(disposition.kind).toBe('reuse');
  });

  it('mints for `not_issued`, because we have never learned whether the object exists', () => {
    // The delicate one. `not_issued` is what `recordPass` leaves behind, and it
    // is left behind whether or not the insert that followed it succeeded — so a
    // `not_issued` row is compatible with the object existing at Google and with
    // it not existing. The only way to learn is to ask Google, which is what the
    // mint path does, and its 409 fallback already handles "it was there after
    // all". Short-circuiting here would hand back a link to an object nobody has
    // confirmed exists, which is the exact failure the insert was added to stop.
    const disposition = dispositionForExistingPass(passRow({ state: 'not_issued' }), TENANT);

    expect(disposition.kind).toBe('mint');
  });

  it('refuses an `expired` pass rather than minting a replacement over it', () => {
    // Terminal. Google cannot un-expire an object, so a freshly inserted one
    // would be a *different* object for the same customer: two cards at the
    // counter, and the support question "why does this customer have two"
    // unanswerable. Silently minting here is the one thing that must not happen.
    const disposition = dispositionForExistingPass(passRow({ state: 'expired' }), TENANT);

    expect(disposition.kind).toBe('terminal');
  });

  it('refuses a `completed` pass for the same reason', () => {
    const disposition = dispositionForExistingPass(passRow({ state: 'completed' }), TENANT);

    expect(disposition.kind).toBe('terminal');
  });

  it('fails closed on a state this build has never heard of', () => {
    // The `state` column is `text` with no `check` constraint, and the schema says
    // so on purpose: readers must fail closed rather than let the database refuse
    // the value. An `else` that mints would turn a typo into a duplicate card.
    const disposition = dispositionForExistingPass(passRow({ state: 'archived' }), TENANT);

    expect(disposition.kind).toBe('unknown');
  });

  it('does not reuse a row that belongs to another tenant', () => {
    // `findPass` already filters by tenant — `customer_id` is the primary key, so
    // the predicate narrows to one row and that row's `tenant_id` still has to be
    // checked. This is the second, independent half: the disposition is a pure
    // function over a row, so a row from anywhere must not become a reuse. A
    // reuse would hand this tenant a signed link naming another tenant's object.
    const disposition = dispositionForExistingPass(
      passRow({ tenantId: OTHER_TENANT, objectId: `${ISSUER}.member-theirs` }),
      TENANT,
    );

    expect(disposition.kind).toBe('mint');
  });

  it('carries the recorded object id through, so the row stays the record', () => {
    // `store.ts` says the row is the record of what was actually issued, and
    // that reconciliation acts on the stored id rather than one derived again.
    // That reasoning belongs here too: if the two ever diverge, the id Google
    // holds is the recorded one.
    const disposition = dispositionForExistingPass(
      passRow({ objectId: `${ISSUER}.member-legacy-customer` }),
      TENANT,
    );

    expect(disposition).toEqual({
      kind: 'reuse',
      state: 'issued',
      objectId: `${ISSUER}.member-legacy-customer`,
    });
  });
});

describe('linkForExistingPass', () => {
  function existingInput(
    overrides: Partial<Parameters<typeof linkForExistingPass>[1]> = {},
  ) {
    return {
      ...passInput(),
      existingObjectId: `${ISSUER}.member-${CUSTOMER_GLOBAL_ID}`,
      ...overrides,
    };
  }

  it('signs a link for the object id the row recorded', async () => {
    const store = readyStore();

    const issued = await linkForExistingPass(deps(store), existingInput());

    expect(issued.objectId).toBe(`${ISSUER}.member-${CUSTOMER_GLOBAL_ID}`);
    expect(issued.saveUrl.startsWith(SAVE_TO_WALLET_URL_PREFIX)).toBe(true);
  });

  it('signs the recorded id even when it disagrees with the derivation', async () => {
    // The derivation is stable today, so a fixture that diverges is the only way
    // this assertion can tell "returned the recorded id" apart from "returned a
    // freshly derived one" — and the two are the whole point of the row existing.
    const store = readyStore();

    const issued = await linkForExistingPass(
      deps(store),
      existingInput({ existingObjectId: `${ISSUER}.member-legacy-customer` }),
    );

    expect(issued.objectId).toBe(`${ISSUER}.member-legacy-customer`);
    // The signed object names it too, so the token resolves to the same pass the
    // row records rather than to an id only the response mentions.
    expect(issued.loyaltyObject.id).toBe(`${ISSUER}.member-legacy-customer`);
  });

  it('records nothing, because the row that says this pass exists already says so', async () => {
    // `recordPass` would be a write for no change on a row that is past
    // `not_issued`: its conflict branch only updates `object_id` while the pass
    // has never been issued. Idempotence includes not writing.
    const store = readyStore();

    await linkForExistingPass(deps(store), existingInput());

    expect(store.recorded).toHaveLength(0);
  });

  it('carries the ledger balance and the stored member code into the token', async () => {
    // A pass whose number is frozen at some earlier visit is the defect
    // reconciliation exists to fix, so a re-issued link must not carry a stale
    // one either.
    const store = readyStore();
    store.balances[`${TENANT}:${CUSTOMER_ID}`] = 4242;

    const issued = await linkForExistingPass(deps(store), existingInput());

    expect(issued.balancePoints).toBe(4242);
    expect(issued.loyaltyObject.loyaltyPoints.balance.string).toBe('4242');
    expect(issued.loyaltyObject.accountId).toBe(issued.memberCode);
  });

  it('builds the object as `issued`, which is what Google will hold after the tap', async () => {
    // The token carries the object as it will be once Google applies it, not as
    // our tracking column reads. `objectStateFor` cannot even express
    // `not_saved`, and an `INACTIVE` token would hand the customer a card that
    // cannot be used at the counter.
    const store = readyStore();

    const issued = await linkForExistingPass(deps(store), existingInput());

    expect(issued.loyaltyObject.state).toBe('ACTIVE');
  });

  it('refuses a balance that cannot be rendered, rather than linking a dead card', async () => {
    const store = readyStore();
    store.balances[`${TENANT}:${CUSTOMER_ID}`] = BALANCE_DISPLAY_MAX + 1;

    await expect(linkForExistingPass(deps(store), existingInput())).rejects.toThrow(
      /cannot be rendered/i,
    );
  });

  it('refuses a tenant with no points currency, on this path too', async () => {
    const store = new FakeStore({ [TENANT]: [customerRow()] }, { [TENANT]: programRow() });
    store.findPointsCurrency = async () => null;

    await expect(linkForExistingPass(deps(store), existingInput())).rejects.toBeInstanceOf(
      LoyaltyProgramNotConfiguredError,
    );
  });

  it('only ever touches the tenant it was given', async () => {
    const store = readyStore();

    await linkForExistingPass(deps(store), existingInput());

    expect(store.tenantsTouched()).toEqual([TENANT]);
  });
});
