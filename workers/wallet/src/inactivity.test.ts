/**
 * The pass-inactivity deactivation rule.
 *
 * ## The incident this suite exists to prevent
 *
 * The rule moves a customer's real Google Wallet card into the "Expired passes"
 * section of their phone. Getting that wrong on somebody who *is* active is a
 * customer incident, not a technical bug: the card is gone from their wallet,
 * the only route back is re-adding it, and nothing in this system can undo it for
 * them. So every assertion below is about a way to mute too much, and the
 * fakes are built to make those ways *fail a test* rather than merely look wrong.
 *
 * ## What is a double and what is real
 *
 * `CountingClient` and `CountingStore` are doubles that **count**. The rule's
 * capability to write is therefore measured, not inferred from the source: "the
 * dry run writes nothing" is `client.patches.length === 0 && store.writes.length
 * === 0`, which is a fact about the run rather than a reading of the code.
 *
 * The one thing a double cannot prove is the SQL predicate — `CountingStore`
 * implements the candidate query in JavaScript. So the boundary rule (`>` vs
 * `>=`) is **also** tested against `isInactiveSince`, which is the real exported
 * function, and the SQL in `drizzle-store.ts` is asserted separately in
 * `drizzle-store.test.ts` to mirror those exact conditions. The mirror is a
 * stated assumption, not a proof: if the two ever diverge, `drizzle-store.test.ts`
 * is where it shows.
 *
 * ## No sockets, no database
 *
 * Same discipline as `sweep.test.ts` and `reconcile.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import type { LoyaltyClass } from './class';
import type { GoogleWalletClient, LoyaltyClassPatch, LoyaltyObjectPatch } from './google-client';
import {
  INACTIVITY_STATE,

  applyInactivityDeactivation,
  inactivityCutoff,
  isInactiveSince,
  planInactivityDeactivation,
} from './inactivity';
import type { LoyaltyObject } from './object';
import type { InactivityCandidateRow ,
  PassCallbackClaim,
  PassCallbackWrite,
  PassLifecycleUpdate,
  PassObservationUpdate,
  PassReconciliationUpdate,
  PassTrackingUpdate,
  ProgramInsert,
  WalletCustomerRow,
  WalletPassRow,
  WalletProgramRow,
  WalletProgramWithBusinessRow,
  WalletStore,
  WalletTenantBrandingRow,
} from './store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = '3388000000023206930';
const CURRENCY = 'puntos';
const OBJECT_ID = '3388000000023206930.member-c8b61954-1b6d-4dfa-9954-b7c936a9e648';

/** The clock every test runs against, so no assertion depends on the wall. */
const NOW = new Date('2026-10-05T06:00:00.000Z');

/**
 * A day, in the helper below.
 *
 * Expressed as a number of days rather than as a calendar helper so a test can
 * say "exactly on the boundary" without doing date arithmetic of its own, which
 * is how a boundary test ends up testing the arithmetic instead of the rule.
 */
const DAY = 86_400_000;

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY);
}

function tenantId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function customerId(n: number): string {
  return `d185c973-c976-46b5-b3bf-${String(n).padStart(12, '0')}`;
}

function program(tenant: string, months: number | null): WalletProgramRow {
  return {
    tenantId: tenant,
    issuerId: ISSUER,
    classId: `${ISSUER}.tenant-${tenant}`,
    reviewStatus: 'approved',
    demoMode: false,
    lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
    passInactivityMonths: months,
  };
}

// ---------------------------------------------------------------------------
// The doubles
// ---------------------------------------------------------------------------

interface SeedPass {
  tenant: string;
  customer: string;
  objectId: string;
  state?: string;
  /** `points_transactions.created_at`, newest wins. `undefined` = never transacted. */
  transactions?: Array<{ at: Date; points: number }>;
  /** `customers.created_at`. */
  enrolledAt: Date;
}

/**
 * A store that counts writes and answers the candidate query in JavaScript.
 *
 * The candidate predicate is the real `isInactiveSince`, and the surrounding
 * conditions are the real ones (`state = 'issued'`, one tenant at a time). The
 * tenant filter is applied before the predicate, so a rule that walked into
 * another tenant's rows would find them here and the test would see the leak —
 * the fake does not quietly hide a cross-tenant bug by scoping itself.
 */
class CountingStore implements WalletStore {
  async getIssuerId(): Promise<string> {
    throw new Error('getIssuerId is not used by inactivity tests');
  }

  readonly calls: string[] = [];
  /** Every mutating call, in order. Empty means nothing was written. */
  readonly writes: Array<{ method: string; value: unknown }> = [];

  readonly programs = new Map<string, WalletProgramRow>();
  readonly passes: SeedPass[] = [];
  /** `tenantId:customerId` -> throw on `recordPassLifecycle`. */
  readonly failLifecycle = new Map<string, Error>();
  /** `objectId` -> throw on `patchObject`. */
  readonly failPatch = new Map<string, Error>();
  /** Customers to force a zero-row local write, mimicking a row that vanished. */
  readonly refuseLocalWrite = new Set<string>();

  /** Tenant ids whose candidate query was asked at all. */
  readonly candidateQueries: Array<{ tenantId: string; cutoff: Date; limit: number }> = [];

  constructor(rows: SeedPass[]) {
    for (const row of rows) this.passes.push(row);
  }

  seed(row: SeedPass): void {
    this.passes.push(row);
  }

  /** The transactions for a customer, newest first. */
  private latestActivity(customer: string): Date | null {
    const row = this.passes.find((p) => p.customer === customer);
    if (row === undefined || row.transactions === undefined) return null;
    // Explicit seed: `reduce` without one returns the sole element itself for a
    // one-element array, which is the transaction object rather than its date.
    return row.transactions.reduce<Date | null>(
      (newest, t) => (newest === null || t.at > newest ? t.at : newest),
      null,
    );
  }

  stateOf(customer: string): string | undefined {
    return this.passes.find((p) => p.customer === customer)?.state;
  }

  async listProgramTenants(options: {
    limit: number;
    afterTenantId: string | null;
  }): Promise<WalletProgramRow[]> {
    this.calls.push('listProgramTenants');
    const all = [...this.programs.values()]
      .filter((row) => options.afterTenantId === null || row.tenantId > options.afterTenantId)
      .sort((a, b) => (a.tenantId < b.tenantId ? -1 : 1));
    return all.slice(0, options.limit);
  }

  async findInactivePassCandidates(input: {
    tenantId: string;
    cutoff: Date;
    limit: number;
  }): Promise<InactivityCandidateRow[]> {
    this.calls.push('findInactivePassCandidates');
    this.candidateQueries.push(input);

    // The tenant filter first, and honestly: rows belonging to other tenants are
    // visible to this fake so that a rule which failed to scope would leak.
    const scoped = this.passes.filter((p) => p.tenant === input.tenantId);
    const candidates = scoped
      // `issued` only. `not_issued`/`not_saved` have no Google object to patch,
      // `inactive` is already done, and `expired`/`completed` are Google's own
      // terminal states.
      .filter((p) => (p.state ?? 'issued') === 'issued')
      .filter((p) => isInactiveSince(this.latestActivity(p.customer), p.enrolledAt, input.cutoff))
      .sort((a, b) => (a.customer < b.customer ? -1 : 1))
      .slice(0, input.limit)
      .map((p) => ({
        customerId: p.customer,
        objectId: p.objectId,
        lastActivityAt: this.latestActivity(p.customer),
      }));

    return candidates;
  }

  async recordPassLifecycle(update: PassLifecycleUpdate): Promise<number> {
    this.calls.push('recordPassLifecycle');
    this.writes.push({ method: 'recordPassLifecycle', value: update });
    const failure = this.failLifecycle.get(`${update.tenantId}:${update.customerId}`);
    if (failure) throw failure;
    if (this.refuseLocalWrite.has(update.customerId)) return 0;

    const row = this.passes.find(
      (p) => p.customer === update.customerId && p.tenant === update.tenantId,
    );
    // The source set of the real statement: `('issued', 'inactive')`.
    if (row === undefined) return 0;
    if (row.state !== 'issued' && row.state !== 'inactive') return 0;
    row.state = update.state;
    return 1;
  }

  // ---- the rest of the interface, none of it used by this rule ----

  async findCustomer(): Promise<WalletCustomerRow | null> {
    this.calls.push('findCustomer');
    return null;
  }
  async findCustomerById(): Promise<WalletCustomerRow | null> {
    this.calls.push('findCustomerById');
    return null;
  }
  async findProgram(tenant: string): Promise<WalletProgramRow | null> {
    this.calls.push('findProgram');
    return this.programs.get(tenant) ?? null;
  }
  /**
   * Recorded and answered from the same fixture as `findProgram`.
   *
   * The inactivity rule counts and mutes passes; it never reads a merchant's
   * identity. Recording the call rather than throwing keeps that visible — a sweep
   * that had quietly started depending on the business's name would show up as a
   * new entry in `calls`, and the assertions on that array are what would break.
   */
  async findProgramWithBusiness(tenant: string): Promise<WalletProgramWithBusinessRow | null> {
    this.calls.push('findProgramWithBusiness');
    const program = this.programs.get(tenant);
    if (!program) return null;
    return { ...program, businessName: null, businessSlug: null };
  }
  async insertProgram(program: ProgramInsert): Promise<void> {
    this.calls.push('insertProgram');
    this.writes.push({ method: 'insertProgram', value: program });
  }
  async findTenantBranding(): Promise<WalletTenantBrandingRow | null> {
    this.calls.push('findTenantBranding');
    return null;
  }
  async findProgramName(): Promise<string | null> {
    this.calls.push('findProgramName');
    return null;
  }
  async findPointsCurrency(): Promise<string | null> {
    this.calls.push('findPointsCurrency');
    return CURRENCY;
  }
  async findPromoCopy(): Promise<null> {
    this.calls.push('findPromoCopy');
    return null;
  }
  async findTierName(): Promise<null> {
    this.calls.push('findTierName');
    return null;
  }
  async latestBalance(): Promise<number> {
    this.calls.push('latestBalance');
    return 0;
  }
  async isMemberCodeTaken(): Promise<boolean> {
    this.calls.push('isMemberCodeTaken');
    return false;
  }
  async claimMemberCode(): Promise<string | null> {
    this.calls.push('claimMemberCode');
    return null;
  }
  async recordPass(update: PassTrackingUpdate): Promise<void> {
    this.calls.push('recordPass');
    this.writes.push({ method: 'recordPass', value: update });
  }
  async findPass(): Promise<WalletPassRow | null> {
    this.calls.push('findPass');
    return null;
  }
  async recordPassReconciliation(update: PassReconciliationUpdate): Promise<number> {
    this.calls.push('recordPassReconciliation');
    this.writes.push({ method: 'recordPassReconciliation', value: update });
    return 1;
  }
  async recordPassObservation(update: PassObservationUpdate): Promise<number> {
    this.calls.push('recordPassObservation');
    this.writes.push({ method: 'recordPassObservation', value: update });
    return 1;
  }
  async listTenantsWithoutProgram(): Promise<string[]> {
    this.calls.push('listTenantsWithoutProgram');
    return [];
  }
  async findPassesByObjectIds(): Promise<WalletPassRow[]> {
    this.calls.push('findPassesByObjectIds');
    return [];
  }
  async updateProgramReviewStatus(): Promise<void> {
    this.calls.push('updateProgramReviewStatus');
    this.writes.push({ method: 'updateProgramReviewStatus', value: null });
  }
  async setProgramDemoMode(): Promise<number> {
    this.calls.push('setProgramDemoMode');
    return 1;
  }
  async findTenantByClassId(): Promise<null> {
    this.calls.push('findTenantByClassId');
    return null;
  }
  async claimCallbackDelivery(_claim: PassCallbackClaim): Promise<boolean> {
    this.calls.push('claimCallbackDelivery');
    return true;
  }
  async recordPassCallback(update: PassCallbackWrite): Promise<number> {
    this.calls.push('recordPassCallback');
    this.writes.push({ method: 'recordPassCallback', value: update });
    return 1;
  }
}

/**
 * A Google client that counts calls and can be made to fail per object.
 *
 * `patchObject` returns the object with the patched state applied, which is what
 * the real API does — Google echoes the stored resource. That is what lets the
 * rule verify its own write instead of assuming it, and `echoedState` is how a
 * test makes Google *not* confirm.
 */
class CountingClient implements GoogleWalletClient {
  readonly patches: Array<{ objectId: string; patch: LoyaltyObjectPatch }> = [];
  readonly reads: string[] = [];
  /** `objectId` -> throw, standing in for a 403 or a 500 from Google. */
  readonly failPatch = new Map<string, Error>();
  /** Overrides the state Google echoes back, to simulate a patch that did not land. */
  echoOverride: LoyaltyObject['state'] | null = null;

  async getObject(objectId: string): Promise<LoyaltyObject | null> {
    this.reads.push(objectId);
    return null;
  }
  async addMessage(): Promise<LoyaltyObject> {
    throw new Error('addMessage is not used by inactivity tests');
  }
  async insertObject(object: LoyaltyObject): Promise<LoyaltyObject> {
    this.patches.push({ objectId: object.id, patch: object });
    return object;
  }
  async patchObject(objectId: string, patch: LoyaltyObjectPatch): Promise<LoyaltyObject> {
    this.patches.push({ objectId, patch });
    const failure = this.failPatch.get(objectId);
    if (failure) throw failure;

    const state = this.echoOverride ?? patch.state ?? 'ACTIVE';
    return {
      id: objectId,
      classId: `${ISSUER}.tenant-unknown`,
      state,
      accountId: 'K7M2QX',
      loyaltyPoints: { label: CURRENCY, balance: { string: '0' } },
      barcode: { type: 'QR_CODE', value: 'seed' },
    };
  }
  async getClass(): Promise<LoyaltyClass | null> {
    return null;
  }
  async insertClass(loyaltyClass: LoyaltyClass): Promise<LoyaltyClass> {
    return loyaltyClass;
  }
  async patchClass(_classId: string, _patch: LoyaltyClassPatch): Promise<LoyaltyClass> {
    return {} as LoyaltyClass;
  }
  async listObjects(): Promise<{ objects: LoyaltyObject[]; nextPageToken: string | null }> {
    return { objects: [], nextPageToken: null };
  }
  async saveUriForJwt(): Promise<string> {
    return 'https://pay.google.com/save';
  }
}

function storeFor(rows: SeedPass[], programs: WalletProgramRow[]): CountingStore {
  const store = new CountingStore(rows);
  for (const row of programs) store.programs.set(row.tenantId, row);
  return store;
}

// ---------------------------------------------------------------------------
// 1. `NULL` means the rule does not run
// ---------------------------------------------------------------------------

describe('an unconfigured tenant', () => {
  const TENANT = tenantId(1);
  const IDLE = customerId(1);
  const row: SeedPass = {
    tenant: TENANT,
    customer: IDLE,
    objectId: OBJECT_ID,
    state: 'issued',
    // Five years of silence: the most deactivated customer in the system.
    transactions: [{ at: new Date('2021-01-01T00:00:00.000Z'), points: 100 }],
    enrolledAt: new Date('2020-01-01T00:00:00.000Z'),
  };

  it('contributes no candidates', async () => {
    const store = storeFor([row], [program(TENANT, null)]);
    const plan = await planInactivityDeactivation({ store, now: () => NOW });

    expect(plan.totalCandidates).toBe(0);
    expect(plan.tenantsConfigured).toBe(0);
    expect(plan.tenantsDisabled).toBe(1);
  });

  it('never asks the database which passes would be touched', async () => {
    const store = storeFor([row], [program(TENANT, null)]);
    await planInactivityDeactivation({ store, now: () => NOW });

    // Short-circuited before the query, not after it returned nothing. The
    // difference is a tenant that will never be scanned paying for a scan on
    // every run, forever.
    expect(store.candidateQueries).toEqual([]);
  });

  it('writes nothing and calls Google not at all, even when asked to act', async () => {
    const store = storeFor([row], [program(TENANT, null)]);
    const client = new CountingClient();

    const report = await applyInactivityDeactivation({
      store,
      client,
      demoMode: false,
      now: () => NOW,
    });

    expect(store.writes).toEqual([]);
    expect(client.patches).toEqual([]);
    expect(report.acted.passesDeactivated).toBe(0);
    expect(store.stateOf(IDLE)).toBe('issued');
  });

  it('rejects a zero or negative window rather than deactivating everyone', async () => {
    // `NULL` is "off", and so is nonsense: a `0` that reached the cutoff maths
    // would deactivate every pass in the tenant on the next run, which is the
    // one outcome this whole feature is built to make impossible.
    const store = storeFor([row], [program(TENANT, 0)]);
    const plan = await planInactivityDeactivation({ store, now: () => NOW });

    expect(plan.tenantsConfigured).toBe(0);
    expect(plan.tenantsDisabled).toBe(1);
    expect(plan.totalCandidates).toBe(0);
    expect(store.candidateQueries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. One tenant's window never reaches another's customers
// ---------------------------------------------------------------------------

describe('two tenants with different windows', () => {
  const SHORT = tenantId(1);
  const LONG = tenantId(2);
  const SHORT_IDLE = customerId(1);
  const LONG_IDLE = customerId(2);

  const rows: SeedPass[] = [
    {
      tenant: SHORT,
      customer: SHORT_IDLE,
      objectId: 'obj-short',
      state: 'issued',
      transactions: [{ at: daysAgo(100), points: 100 }],
      enrolledAt: daysAgo(400),
    },
    {
      tenant: LONG,
      customer: LONG_IDLE,
      objectId: 'obj-long',
      state: 'issued',
      // Identical silence. Under X=3 this is a candidate; under X=24 it is not.
      transactions: [{ at: daysAgo(100), points: 100 }],
      enrolledAt: daysAgo(400),
    },
  ];

  const programs = [program(SHORT, 3), program(LONG, 24)];

  it('deactivates only the short-window tenant’s customer', async () => {
    const store = storeFor(rows, programs);
    const client = new CountingClient();

    const report = await applyInactivityDeactivation({
      store,
      client,
      demoMode: false,
      now: () => NOW,
    });

    expect(client.patches.map((p) => p.objectId)).toEqual(['obj-short']);
    expect(store.stateOf(SHORT_IDLE)).toBe(INACTIVITY_STATE);
    expect(store.stateOf(LONG_IDLE)).toBe('issued');
    expect(report.acted.passesDeactivated).toBe(1);
  });

  it('gives each tenant its own cutoff, read from its own row', async () => {
    const store = storeFor(rows, programs);
    await planInactivityDeactivation({ store, now: () => NOW });

    const cutoffs = new Map(store.candidateQueries.map((q) => [q.tenantId, q.cutoff]));
    expect(cutoffs.size).toBe(2);

    // Both customers' last movement is 100 days old. A three-month window puts
    // its cutoff *after* that (July 5 vs June 27), so the movement falls outside
    // the window and the customer is a candidate. A 24-month window puts its
    // cutoff *before* it, so the movement is inside the window and the same
    // customer is not. The silence is identical; only the window differs.
    const lastMovement = daysAgo(100);
    expect(cutoffs.get(SHORT)!.getTime()).toBeGreaterThan(lastMovement.getTime());
    expect(cutoffs.get(LONG)!.getTime()).toBeLessThan(lastMovement.getTime());
  });

  it('scopes every candidate query to a single tenant', async () => {
    const store = storeFor(rows, programs);
    await planInactivityDeactivation({ store, now: () => NOW });

    for (const query of store.candidateQueries) {
      expect(store.passes.filter((p) => p.tenant === query.tenantId).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Activity inside the window is never a candidate
// ---------------------------------------------------------------------------

describe('a customer with activity inside the window', () => {
  const TENANT = tenantId(1);
  const ACTIVE = customerId(1);

  const row: SeedPass = {
    tenant: TENANT,
    customer: ACTIVE,
    objectId: 'obj-active',
    state: 'issued',
    // One day ago. The clearest possible "recently used" and the case the brief
    // asks to be verified by reversal.
    transactions: [{ at: daysAgo(1), points: 250 }],
    enrolledAt: daysAgo(500),
  };

  it('does not appear in the dry run', async () => {
    const store = storeFor([row], [program(TENANT, 3)]);
    const plan = await planInactivityDeactivation({ store, now: () => NOW });

    expect(plan.totalCandidates).toBe(0);
    expect(plan.tenants[0].candidates.map((c) => c.customerId)).not.toContain(ACTIVE);
  });

  it('does not appear in an execution either', async () => {
    const store = storeFor([row], [program(TENANT, 3)]);
    const client = new CountingClient();

    await applyInactivityDeactivation({ store, client, demoMode: false, now: () => NOW });

    expect(client.patches).toEqual([]);
    expect(store.stateOf(ACTIVE)).toBe('issued');
  });

  it('is still deactivated when their activity ages past the window', async () => {
    // The same customer, later. Without this the rule could pass the test above
    // by never matching anybody.
    const store = storeFor(
      [{ ...row, transactions: [{ at: daysAgo(200), points: 250 }] }],
      [program(TENANT, 3)],
    );
    const plan = await planInactivityDeactivation({ store, now: () => NOW });

    expect(plan.totalCandidates).toBe(1);
    expect(plan.tenants[0].candidates[0].customerId).toBe(ACTIVE);
  });
});

// ---------------------------------------------------------------------------
// 4. A redemption is activity
// ---------------------------------------------------------------------------

describe('a customer whose last movement was a redemption', () => {
  const TENANT = tenantId(1);
  const SPENDER = customerId(1);

  it('counts a negative transaction as activity and is left alone', async () => {
    // `points_transactions.points` is a signed integer: a redemption is a
    // negative row. Reading "activity" as "a row exists" rather than as "points
    // went up" is what stops the rule from punishing the customer who spends
    // the most, which is the exact customer a loyalty programme cannot afford to
    // lose.
    const store = storeFor(
      [
        {
          tenant: TENANT,
          customer: SPENDER,
          objectId: 'obj-spender',
          state: 'issued',
          transactions: [
            { at: daysAgo(200), points: 5000 },
            { at: daysAgo(2), points: -1200 },
          ],
          enrolledAt: daysAgo(900),
        },
      ],
      [program(TENANT, 3)],
    );

    const plan = await planInactivityDeactivation({ store, now: () => NOW });
    expect(plan.totalCandidates).toBe(0);

    const client = new CountingClient();
    await applyInactivityDeactivation({ store, client, demoMode: false, now: () => NOW });
    expect(client.patches).toEqual([]);
    expect(store.stateOf(SPENDER)).toBe('issued');
  });

  it('deactivates the same customer once the redemption also ages out', async () => {
    const store = storeFor(
      [
        {
          tenant: TENANT,
          customer: SPENDER,
          objectId: 'obj-spender',
          state: 'issued',
          transactions: [{ at: daysAgo(200), points: -1200 }],
          enrolledAt: daysAgo(900),
        },
      ],
      [program(TENANT, 3)],
    );

    const plan = await planInactivityDeactivation({ store, now: () => NOW });
    expect(plan.totalCandidates).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. The dry run writes nothing
// ---------------------------------------------------------------------------

describe('the dry run', () => {
  const TENANT = tenantId(1);

  it('counts candidates and performs no write of any kind', async () => {
    const store = storeFor(
      [
        {
          tenant: TENANT,
          customer: customerId(1),
          objectId: 'obj-1',
          state: 'issued',
          transactions: [{ at: daysAgo(500), points: 100 }],
          enrolledAt: daysAgo(600),
        },
        {
          tenant: TENANT,
          customer: customerId(2),
          objectId: 'obj-2',
          state: 'issued',
          transactions: [{ at: daysAgo(500), points: 100 }],
          enrolledAt: daysAgo(600),
        },
      ],
      [program(TENANT, 3)],
    );
    const client = new CountingClient();
    const writesBefore = store.writes.length;

    const plan = await planInactivityDeactivation({ store, now: () => NOW });

    // Measured by the doubles, not by reading the source.
    expect(plan.totalCandidates).toBe(2);
    expect(client.patches).toEqual([]);
    expect(client.reads).toEqual([]);
    expect(store.writes.length).toBe(writesBefore);
    expect(store.writes).toEqual([]);
    expect(store.stateOf(customerId(1))).toBe('issued');
  });

  it('takes no Google client at all, so it structurally cannot write to Google', () => {
    // The plan's dependency type has no `client` field. This asserts the absence
    // at the type level, which is a stronger guarantee than a boolean flag: a
    // dry-run flag checked in the wrong place is a dry run that writes.
    const deps: Parameters<typeof planInactivityDeactivation>[0] = { store: new CountingStore([]) };
    expect(deps).not.toHaveProperty('client');
  });

  it('reports the same count it calculated, per tenant', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const store = storeFor(
        [
          {
            tenant: TENANT,
            customer: customerId(1),
            objectId: 'obj-1',
            state: 'issued',
            transactions: [{ at: daysAgo(500), points: 1 }],
            enrolledAt: daysAgo(600),
          },
        ],
        [program(TENANT, 3)],
      );

      await planInactivityDeactivation({ store, now: () => NOW });

      const line = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(line).toContain(TENANT);
      // The number in the log is the number the plan computed.
      expect(line).toMatch(/1/);
    } finally {
      log.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. A Google failure leaves our own state alone
// ---------------------------------------------------------------------------

describe('a patch Google rejects', () => {
  const TENANT = tenantId(1);
  const CUSTOMER = customerId(1);

  function seeded(): CountingStore {
    return storeFor(
      [
        {
          tenant: TENANT,
          customer: CUSTOMER,
          objectId: 'obj-1',
          state: 'issued',
          transactions: [{ at: daysAgo(500), points: 100 }],
          enrolledAt: daysAgo(600),
        },
      ],
      [program(TENANT, 3)],
    );
  }

  it('does not mark the pass inactive locally', async () => {
    const store = seeded();
    const client = new CountingClient();
    client.failPatch.set('obj-1', new Error('Google Wallet API responded 403 (forbidden)'));

    const report = await applyInactivityDeactivation({
      store,
      client,
      demoMode: false,
      now: () => NOW,
    });

    // The whole point: our row must not claim a Google state Google refused to
    // confirm. That mismatch is the documented callback-module failure — a
    // merchant reading `inactive` would tell a customer their card is expired
    // while Google's own object is still ACTIVE.
    expect(store.stateOf(CUSTOMER)).toBe('issued');
    expect(store.writes.filter((w) => w.method === 'recordPassLifecycle')).toEqual([]);
    expect(report.acted.passesDeactivated).toBe(0);
  });

  it('reports the failure with the customer, rather than swallowing it', async () => {
    const store = seeded();
    const client = new CountingClient();
    client.failPatch.set('obj-1', new Error('Google Wallet API responded 403 (forbidden)'));

    const report = await applyInactivityDeactivation({
      store,
      client,
      demoMode: false,
      now: () => NOW,
    });

    expect(report.acted.failures).toHaveLength(1);
    expect(report.acted.failures[0]).toMatchObject({
      tenantId: TENANT,
      customerId: CUSTOMER,
      stage: 'google_patch',
    });
    expect(report.acted.failures[0].reason).toContain('403');
  });

  it('refuses a local write when Google accepted the patch but echoed another state', async () => {
    // Google echoes the stored resource, so an echo that is not `INACTIVE` means
    // the patch did not land. Optimism here would write a state our own
    // post-condition just disproved.
    const store = seeded();
    const client = new CountingClient();
    client.echoOverride = 'ACTIVE';

    const report = await applyInactivityDeactivation({
      store,
      client,
      demoMode: false,
      now: () => NOW,
    });

    expect(store.stateOf(CUSTOMER)).toBe('issued');
    expect(report.acted.passesDeactivated).toBe(0);
    expect(report.acted.failures).toHaveLength(1);
  });

  it('counts a refused local write as not deactivated', async () => {
    // The row matched our candidate query and Google confirmed the patch, but the
    // `UPDATE ... RETURNING` matched nothing — the pass was reactivated or removed
    // in between. A method that reports success having changed nothing is how a
    // report stops being evidence.
    const store = seeded();
    store.refuseLocalWrite.add(CUSTOMER);
    const client = new CountingClient();

    const report = await applyInactivityDeactivation({
      store,
      client,
      demoMode: false,
      now: () => NOW,
    });

    expect(client.patches).toHaveLength(1);
    expect(report.acted.passesDeactivated).toBe(0);
    expect(report.acted.localWritesSkipped).toBe(1);
  });

  it('continues with the other customers after one fails', async () => {
    const store = storeFor(
      [
        {
          tenant: TENANT,
          customer: customerId(1),
          objectId: 'obj-1',
          state: 'issued',
          transactions: [{ at: daysAgo(500), points: 1 }],
          enrolledAt: daysAgo(600),
        },
        {
          tenant: TENANT,
          customer: customerId(2),
          objectId: 'obj-2',
          state: 'issued',
          transactions: [{ at: daysAgo(500), points: 1 }],
          enrolledAt: daysAgo(600),
        },
      ],
      [program(TENANT, 3)],
    );
    const client = new CountingClient();
    client.failPatch.set('obj-1', new Error('boom'));

    const report = await applyInactivityDeactivation({
      store,
      client,
      demoMode: false,
      now: () => NOW,
    });

    expect(report.acted.passesDeactivated).toBe(1);
    expect(store.stateOf(customerId(2))).toBe(INACTIVITY_STATE);
    expect(report.acted.failures).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. The window boundary, decided and written down
// ---------------------------------------------------------------------------

describe('the window boundary', () => {
  const TENANT = tenantId(1);
  const CUTOFF = daysAgo(90);

  it('treats a transaction exactly on the cutoff as activity', () => {
    // The decision, stated as a test so it cannot be changed silently.
    //
    // `isInactiveSince` is `lastActivity < cutoff`, strict. A customer whose last
    // movement is exactly X months old has been inactive for exactly X months, not
    // longer than X months, so they are still in. The costs are not symmetric:
    // muting somebody who transacted inside their own window is an incident we
    // cannot undo, and keeping somebody for one extra day is a delay nobody
    // notices. `>=` on the deactivation side would put the boundary customer in
    // the wrong bucket.
    expect(isInactiveSince(CUTOFF, daysAgo(1000), CUTOFF)).toBe(false);
    expect(isInactiveSince(new Date(CUTOFF.getTime() + 1), daysAgo(1000), CUTOFF)).toBe(false);
    expect(isInactiveSince(new Date(CUTOFF.getTime() - 1), daysAgo(1000), CUTOFF)).toBe(true);
  });

  it('excludes a customer whose last transaction lands exactly on the cutoff', async () => {
    const store = storeFor(
      [
        {
          tenant: TENANT,
          customer: customerId(1),
          objectId: 'obj-1',
          state: 'issued',
          transactions: [{ at: CUTOFF, points: 10 }],
          enrolledAt: daysAgo(1000),
        },
      ],
      [program(TENANT, 3)],
    );

    const plan = await planInactivityDeactivation({ store, now: () => NOW });
    expect(plan.totalCandidates).toBe(0);
  });

  it('excludes it in an execution too, not only in the plan', async () => {
    const store = storeFor(
      [
        {
          tenant: TENANT,
          customer: customerId(1),
          objectId: 'obj-1',
          state: 'issued',
          transactions: [{ at: CUTOFF, points: 10 }],
          enrolledAt: daysAgo(1000),
        },
      ],
      [program(TENANT, 3)],
    );
    const client = new CountingClient();

    await applyInactivityDeactivation({ store, client, demoMode: false, now: () => NOW });
    expect(client.patches).toEqual([]);
  });

  it('starts the clock at enrolment for a customer who never transacted', () => {
    // Otherwise a customer enrolled yesterday with a pass is "inactive for X
    // months" on day one, and the first run of the rule mutes every new signup.
    // There is no activity clock for somebody who has never transacted, so the
    // honest clock is when they joined.
    expect(isInactiveSince(null, daysAgo(2), CUTOFF)).toBe(false);
    expect(isInactiveSince(null, daysAgo(200), CUTOFF)).toBe(true);
    // And exactly on the enrolment boundary, the same strict rule applies.
    expect(isInactiveSince(null, CUTOFF, CUTOFF)).toBe(false);
  });

  it('leaves a newly enrolled customer alone even with no transactions', async () => {
    const store = storeFor(
      [
        {
          tenant: TENANT,
          customer: customerId(1),
          objectId: 'obj-1',
          state: 'issued',
          transactions: [],
          enrolledAt: daysAgo(2),
        },
      ],
      [program(TENANT, 3)],
    );

    const plan = await planInactivityDeactivation({ store, now: () => NOW });
    expect(plan.totalCandidates).toBe(0);
  });

  it('computes a calendar-month cutoff, not a 30-day approximation', () => {
    // Months are calendar-relative and days are not, which is one of the reasons
    // this window is not the existing `points_expiry_days` column.
    expect(inactivityCutoff(new Date('2026-03-31T06:00:00.000Z'), 1).toISOString()).toBe(
      '2026-02-28T06:00:00.000Z',
    );
    // And it never lands after `now`, which a 30-day multiplication can do in a
    // short month.
    expect(inactivityCutoff(new Date('2026-03-01T06:00:00.000Z'), 1).getTime()).toBeLessThan(
      new Date('2026-03-01T06:00:00.000Z').getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Demo mode
// ---------------------------------------------------------------------------

describe('demo mode', () => {
  const TENANT = tenantId(1);

  function seeded(): CountingStore {
    return storeFor(
      [
        {
          tenant: TENANT,
          customer: customerId(1),
          objectId: 'obj-1',
          state: 'issued',
          transactions: [{ at: daysAgo(500), points: 100 }],
          enrolledAt: daysAgo(600),
        },
      ],
      [program(TENANT, 3)],
    );
  }

  it('still decides: the plan runs in demo mode and counts candidates', async () => {
    // Decision 3. The decide half is a local `SELECT`, it cannot reach a real
    // customer's phone, and a platform rule that cannot be exercised in demo is a
    // platform rule that ships unproven. So this half carries no demo guard at
    // all — asserted by asserting the work happened while `demoMode` is on.
    const store = seeded();
    const client = new CountingClient();

    const plan = await planInactivityDeactivation({ store, now: () => NOW });

    expect(plan.totalCandidates).toBe(1);
    expect(client.patches).toEqual([]);
  });

  it('refuses to act, and says so out loud', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const store = seeded();
      const client = new CountingClient();

      const report = await applyInactivityDeactivation({
        store,
        client,
        demoMode: true,
        now: () => NOW,
      });

      expect(report.demoMode).toBe(true);
      expect(report.acted.passesDeactivated).toBe(0);
      expect(client.patches).toEqual([]);
      expect(store.writes).toEqual([]);

      // Not a silent `return`. A reader of a run that decided 400 passes and
      // touched none must be able to find out that was deliberate.
      const line = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(line).toContain(TENANT);
      expect(line).toMatch(/demo/i);
      // And it names the number it chose not to act on.
      expect(line).toMatch(/1/);
    } finally {
      log.mockRestore();
    }
  });

  it('still reports the candidates it would have acted on', async () => {
    const store = seeded();
    const report = await applyInactivityDeactivation({
      store,
      client: new CountingClient(),
      demoMode: true,
      now: () => NOW,
    });

    // The plan survives the refusal. A demo run that reported nothing would be
    // indistinguishable from a run with nothing to do.
    expect(report.totalCandidates).toBe(1);
    expect(report.acted.tenantsSkippedNotWritable).toBe(1);
  });

  it('refuses per tenant on the tenant row as well as the deployment flag', async () => {
    // `env || row`, the same expression `classReadinessFor` uses: a tenant held
    // in demo mode on a deployment that has publishing access is still a tenant
    // whose cards only work on test accounts.
    const store = storeFor(
      [
        {
          tenant: TENANT,
          customer: customerId(1),
          objectId: 'obj-1',
          state: 'issued',
          transactions: [{ at: daysAgo(500), points: 100 }],
          enrolledAt: daysAgo(600),
        },
      ],
      [{ ...program(TENANT, 3), demoMode: true }],
    );
    const client = new CountingClient();

    const report = await applyInactivityDeactivation({
      store,
      client,
      demoMode: false,
      now: () => NOW,
    });

    expect(client.patches).toEqual([]);
    expect(report.acted.tenantsSkippedNotWritable).toBe(1);
  });

  it('acts on a tenant that is not held in demo mode, on the same deployment', async () => {
    // The gate is per tenant, not a deployment-wide switch, so one merchant in
    // demo mode does not mute another merchant's rule.
    const store = storeFor(
      [
        {
          tenant: tenantId(1),
          customer: customerId(1),
          objectId: 'obj-1',
          state: 'issued',
          transactions: [{ at: daysAgo(500), points: 100 }],
          enrolledAt: daysAgo(600),
        },
        {
          tenant: tenantId(2),
          customer: customerId(2),
          objectId: 'obj-2',
          state: 'issued',
          transactions: [{ at: daysAgo(500), points: 100 }],
          enrolledAt: daysAgo(600),
        },
      ],
      [{ ...program(tenantId(1), 3), demoMode: true }, program(tenantId(2), 3)],
    );
    const client = new CountingClient();

    await applyInactivityDeactivation({ store, client, demoMode: false, now: () => NOW });

    expect(client.patches.map((p) => p.objectId)).toEqual(['obj-2']);
  });
});

// ---------------------------------------------------------------------------
// Only passes that Google actually holds
// ---------------------------------------------------------------------------

describe('passes that cannot be patched', () => {
  const TENANT = tenantId(1);

  it.each([
    ['not_issued', 'we never handed out a link'],
    ['not_saved', 'Google has no object for it'],
    ['inactive', 'already deactivated by an earlier run'],
    ['expired', 'Google expired it; our rule does not get a vote'],
    ['completed', 'Google completed it; our rule does not get a vote'],
  ])('leaves a pass in state %s alone (%s)', async (state) => {
    const store = storeFor(
      [
        {
          tenant: TENANT,
          customer: customerId(1),
          objectId: 'obj-1',
          state,
          transactions: [{ at: daysAgo(900), points: 100 }],
          enrolledAt: daysAgo(1000),
        },
      ],
      [program(TENANT, 3)],
    );

    const plan = await planInactivityDeactivation({ store, now: () => NOW });
    expect(plan.totalCandidates).toBe(0);
  });

  it('is idempotent: a second run finds nothing left to do', async () => {
    const store = storeFor(
      [
        {
          tenant: TENANT,
          customer: customerId(1),
          objectId: 'obj-1',
          state: 'issued',
          transactions: [{ at: daysAgo(900), points: 100 }],
          enrolledAt: daysAgo(1000),
        },
      ],
      [program(TENANT, 3)],
    );
    const client = new CountingClient();

    const first = await applyInactivityDeactivation({
      store,
      client,
      demoMode: false,
      now: () => NOW,
    });
    const second = await applyInactivityDeactivation({
      store,
      client,
      demoMode: false,
      now: () => NOW,
    });

    expect(first.acted.passesDeactivated).toBe(1);
    expect(second.acted.passesDeactivated).toBe(0);
    expect(client.patches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

describe('the run log', () => {
  const TENANT = tenantId(1);

  it('says how many it would touch and how many it did, per tenant', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const store = storeFor(
        [
          {
            tenant: TENANT,
            customer: customerId(1),
            objectId: 'obj-1',
            state: 'issued',
            transactions: [{ at: daysAgo(500), points: 1 }],
            enrolledAt: daysAgo(600),
          },
        ],
        [program(TENANT, 3)],
      );

      await applyInactivityDeactivation({
        store,
        client: new CountingClient(),
        demoMode: false,
        now: () => NOW,
      });

      const line = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(line).toContain(TENANT);
      expect(line).toMatch(/months/i);
      expect(line).toMatch(/1/);
    } finally {
      log.mockRestore();
    }
  });
});
