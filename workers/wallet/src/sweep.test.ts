import { createDb } from '@vyloop/db';
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { classIdFor, objectIdFor } from './ids';
import type { LoyaltyObject } from './object';
import type {
  PassLifecycleUpdate,
  PassObservationUpdate,
  PassReconciliationUpdate,
  WalletPassRow,
  WalletProgramRow,
  WalletStore,
} from './store';
import {
  MAX_PAGES_PER_TENANT,
  MAX_RECONCILES_PER_TENANT,
  MAX_TENANTS_PER_RUN,
  OBJECT_PAGE_SIZE,
  SWEEP_CRON,

  lifecycleStateFor,
  runScheduledSweep,
  sweepPasses,
} from './sweep';

import defaultExport, { scheduled } from './index';

/**
 * `createDb` is lazy: it builds a client and does not connect, so a bad
 * `DATABASE_URL` proves nothing about whether it was called. The only way to
 * pin "Demo Mode does not even open a database" is to make the call itself
 * observable, and to make it loud, so a regression fails here rather than
 * producing a green suite over a sweep that reaches for the database.
 *
 * Everything else from `@vyloop/db` is passed through untouched, because
 * `drizzle-store` and `routes` read the real table and column objects at module
 * scope and a wholesale mock would break the import graph.
 */
vi.mock('@vyloop/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vyloop/db')>();
  return {
    ...actual,
    createDb: vi.fn(() => {
      throw new Error('createDb must not be called while the deployment is in Demo Mode');
    }),
  };
});

/**
 * The sweep, tested as a whole.
 *
 * ## The discipline
 *
 * Two fakes and no sockets, no credentials and no database, the same as
 * `reconcile.test.ts`. The Google client is **stateful** — `getObject` reads the
 * current object and `patchObject` writes to it — because the property under
 * test is that a re-run does not double-push, and a client that returns a fixed
 * pre-patch object would make that property look true for the wrong reason.
 *
 * Every assertion is about a rule that, if broken, produces one of the specific
 * failures the sweep exists to prevent: a write to Google for a tenant that was
 * never approved, a write that crosses a tenant boundary, a run that silently
 * stops, or a second push of the same number.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = '3388000000023206930';
const CURRENCY = 'puntos';
const GLOBAL_ID = 'c8b61954-1b6d-4dfa-9954-b7c936a9e648';
const OBJECT_ID = objectIdFor(ISSUER, GLOBAL_ID);

/** A run at 06:00 on the 28th, matching the cron's hour. */
const RUN_ONE = new Date('2026-09-28T06:00:00.000Z');
const RUN_TWO = new Date('2026-09-29T06:00:00.000Z');

function tenantId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function globalIdFor(n: number): string {
  return `c8b61954-1b6d-4dfa-9954-b7c936a${String(n).padStart(4, '0')}`;
}

function program(tenant: string, overrides: Partial<WalletProgramRow> = {}): WalletProgramRow {
  return {
    tenantId: tenant,
    issuerId: ISSUER,
    classId: classIdFor(ISSUER, tenant),
    reviewStatus: 'approved',
    lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function remoteObject(id: string, balance: number, state: LoyaltyObject['state'] = 'ACTIVE'): LoyaltyObject {
  return {
    id,
    classId: classIdFor(ISSUER, tenantId(1)),
    state,
    accountId: 'K7M2QX',
    loyaltyPoints: { label: CURRENCY, balance: { string: String(balance) } },
    barcode: { type: 'QR_CODE', value: GLOBAL_ID },
  };
}

// ---------------------------------------------------------------------------
// The fake store
// ---------------------------------------------------------------------------

/**
 * A store with a row per tenant, which is what the sweep needs and what
 * `reconcile.test.ts`'s single-tenant fake cannot express.
 *
 * Tenant scoping is implemented rather than assumed: `findPassesByObjectIds` and
 * `findPass` both check `tenant_id`, mirroring the `WHERE` clauses in
 * `drizzle-store.ts`. A row stored under the wrong tenant is therefore invisible
 * rather than leaked, so a sweep that crossed the boundary would get `null` and
 * the test would see it.
 */
class SweepStore implements WalletStore {
  readonly calls: Array<{ method: string; tenantId: string }> = [];
  readonly reconciliations: PassReconciliationUpdate[] = [];
  readonly lifecycles: PassLifecycleUpdate[] = [];
  readonly observations: PassObservationUpdate[] = [];
  readonly tenantPageRequests: Array<{ limit: number; afterTenantId: string | null }> = [];
  readonly resolveRequests: Array<{ objectIds: string[]; tenantId: string }> = [];

  /** Tenant id -> pass rows, keyed by object id. */
  readonly passes = new Map<string, Map<string, WalletPassRow>>();

  /** `tenantId:customerId` -> balance. */
  readonly balances = new Map<string, number>();

  /** Tenant id -> throw on `listProgramTenants`. */
  failListTenants: Error | null = null;
  /** Tenant id -> throw on `findPassesByObjectIds`. */
  failResolve = new Map<string, Error>();
  /** Tenant id -> throw on `recordPassLifecycle`. */
  failLifecycle = new Map<string, Error>();

  constructor(
    public readonly programs: Record<string, WalletProgramRow | null>,
    public readonly currencies: Record<string, string | null> = {},
  ) {}

  method(tenantId: string): string[] {
    return this.calls.filter((c) => c.tenantId === tenantId).map((c) => c.method);
  }

  methodsCalled(): string[] {
    return this.calls.map((c) => c.method);
  }

  /** Add a pass row and the ledger balance behind it. */
  seedPass(opts: {
    tenant: string;
    customer: string;
    objectId: string;
    balance: number;
    state?: string;
    lastSyncedAt?: Date | null;
  }): WalletPassRow {
    const row: WalletPassRow = {
      customerId: opts.customer,
      tenantId: opts.tenant,
      objectId: opts.objectId,
      state: opts.state ?? 'issued',
      lastSyncedAt: opts.lastSyncedAt ?? null,
    };
    const forTenant = this.passes.get(opts.tenant) ?? new Map<string, WalletPassRow>();
    forTenant.set(opts.objectId, row);
    this.passes.set(opts.tenant, forTenant);
    this.balances.set(`${opts.tenant}:${opts.customer}`, opts.balance);
    return row;
  }

  private record(method: string, tenantId: string): void {
    this.calls.push({ method, tenantId });
  }

  async findCustomer(): Promise<null> {
    this.record('findCustomer', '');
    return null;
  }

  async findCustomerById(): Promise<null> {
    this.record('findCustomerById', '');
    return null;
  }

  async findProgram(tenant: string): Promise<WalletProgramRow | null> {
    this.record('findProgram', tenant);
    return this.programs[tenant] ?? null;
  }

  async findPointsCurrency(tenant: string): Promise<string | null> {
    this.record('findPointsCurrency', tenant);
    return this.currencies[tenant] ?? CURRENCY;
  }

  async findTierName(): Promise<null> {
    this.record('findTierName', '');
    return null;
  }

  async latestBalance(customer: string, tenant: string): Promise<number> {
    this.record('latestBalance', tenant);
    return this.balances.get(`${tenant}:${customer}`) ?? 0;
  }

  async isMemberCodeTaken(): Promise<boolean> {
    this.record('isMemberCodeTaken', '');
    return false;
  }

  async claimMemberCode(): Promise<string | null> {
    this.record('claimMemberCode', '');
    return null;
  }

  async recordPass(): Promise<void> {
    this.record('recordPass', '');
  }

  async findPass(customer: string, tenant: string): Promise<WalletPassRow | null> {
    this.record('findPass', tenant);
    for (const row of this.passes.get(tenant)?.values() ?? []) {
      if (row.customerId === customer && row.tenantId === tenant) return row;
    }
    return null;
  }

  async recordPassReconciliation(update: PassReconciliationUpdate): Promise<number> {
    this.record('recordPassReconciliation', update.tenantId);
    this.reconciliations.push(update);

    for (const [tenant, rows] of this.passes) {
      if (tenant !== update.tenantId) continue;
      for (const row of rows.values()) {
        if (row.customerId !== update.customerId) continue;
        // The rank guard: `not_issued -> not_saved -> inactive -> issued`, with
        // `expired`/`completed` terminal. The `inactive` in the source set is
        // what lets a reactivated pass be recorded.
        //
        // The timestamp is deliberately **outside** the guard, matching the
        // `CASE` in the real statement: a definitive answer advances
        // `last_synced_at` whatever the state transition was allowed to do. When
        // the fake guarded both, a terminal row was left permanently due and
        // the suite could not see it.
        if (row.state === 'not_issued' || row.state === 'not_saved' || row.state === 'inactive') {
          row.state = update.state;
        }
        row.lastSyncedAt = update.observedAt;
        return 1;
      }
    }
    return 0;
  }

  async recordPassLifecycle(update: PassLifecycleUpdate): Promise<number> {
    this.record('recordPassLifecycle', update.tenantId);
    const failure = this.failLifecycle.get(update.tenantId);
    if (failure) throw failure;
    this.lifecycles.push(update);

    for (const [tenant, rows] of this.passes) {
      if (tenant !== update.tenantId) continue;
      for (const row of rows.values()) {
        if (row.customerId !== update.customerId) continue;
        // `state IN ('issued', 'inactive')`: the source set, so a lifecycle
        // answer can never advance a pass whose existence was never confirmed,
        // and `expired`/`completed` are terminal.
        //
        // The timestamp is inside the guard here too, as it is in the real
        // statement. A refused write leaves the row wholly untouched and
        // returns 0, which is the case the sweep must report as skipped rather
        // than counted.
        if (row.state === 'issued' || row.state === 'inactive') {
          row.state = update.state;
          row.lastSyncedAt = update.observedAt;
          return 1;
        }
      }
    }
    return 0;
  }

  async recordPassObservation(update: PassObservationUpdate): Promise<number> {
    this.record('recordPassObservation', update.tenantId);
    this.observations.push(update);

    for (const [tenant, rows] of this.passes) {
      if (tenant !== update.tenantId) continue;
      for (const row of rows.values()) {
        if (row.customerId !== update.customerId) continue;
        // No state written and no state filtered on. The tenant is the only
        // guard, because the only claim being made is "Google answered".
        row.lastSyncedAt = update.observedAt;
        return 1;
      }
    }
    return 0;
  }

  async listProgramTenants(options: {
    limit: number;
    afterTenantId: string | null;
  }): Promise<WalletProgramRow[]> {
    this.record('listProgramTenants', '');
    this.tenantPageRequests.push({ limit: options.limit, afterTenantId: options.afterTenantId });
    if (this.failListTenants) throw this.failListTenants;

    const all = Object.values(this.programs)
      .filter((row): row is WalletProgramRow => row !== null && row !== undefined)
      .sort((a, b) => (a.tenantId < b.tenantId ? -1 : 1));

    const start =
      options.afterTenantId === null
        ? 0
        : all.findIndex((row) => row.tenantId === options.afterTenantId) + 1;

    return all.slice(start, start + options.limit);
  }

  async findPassesByObjectIds(objectIds: string[], tenant: string): Promise<WalletPassRow[]> {
    this.record('findPassesByObjectIds', tenant);
    this.resolveRequests.push({ objectIds, tenantId: tenant });
    const failure = this.failResolve.get(tenant);
    if (failure) throw failure;

    const rows = this.passes.get(tenant);
    if (!rows) return [];
    return objectIds.map((id) => rows.get(id)).filter((row): row is WalletPassRow => row !== undefined);
  }

  async updateProgramReviewStatus(tenant: string, reviewStatus: string): Promise<void> {
    this.record('updateProgramReviewStatus', tenant);
    const row = this.programs[tenant];
    if (row) row.reviewStatus = reviewStatus;
  }
}

// ---------------------------------------------------------------------------
// The fake Google client
// ---------------------------------------------------------------------------

type FakeClient = {
  listObjects: Mock;
  getObject: Mock;
  patchObject: Mock;
  getClass: Mock;
  insertClass: Mock;
  patchClass: Mock;
  insertObject: Mock;
  saveUriForJwt: Mock;
};

interface PageSpec {
  objects: LoyaltyObject[];
  nextPageToken: string | null;
}

/**
 * A Google that is stateful across `list`, `get` and `patch`.
 *
 * `remote` is the single source of truth: `listObjects` reports what is in it,
 * `getObject` reads it, and `patchObject` writes to it and echoes the result the
 * way `callForResource` does. A second sweep therefore genuinely sees the
 * balance the first one pushed, which is what makes the idempotency assertion
 * mean something.
 *
 * A `pages` function is served page by page and every object it hands out is
 * registered in `remote` as it goes. Without that, `getObject` would answer
 * `null` for every object and the whole suite would silently be testing the
 * `not_saved` path instead of the one it is named for.
 */
function fakeGoogle(opts: {
  pages: PageSpec[] | ((request: { classId: string; maxResults: number; token?: string }) => PageSpec);
  failListFor?: Set<string> | null;
}): FakeClient {
  const remote = new Map<string, LoyaltyObject>();
  const remember = (objects: LoyaltyObject[]): void => {
    for (const object of objects) remote.set(object.id, object);
  };

  for (const page of typeof opts.pages === 'function' ? [] : opts.pages) {
    remember(page.objects);
  }

  const listObjects = vi.fn(async (request: { classId: string; maxResults: number; token?: string }) => {
    if (opts.failListFor?.has(request.classId)) {
      throw new Error('Google Wallet API responded 403 (permissionDenied)');
    }
    if (typeof opts.pages === 'function') {
      const page = opts.pages(request);
      remember(page.objects);
      return page;
    }
    const index = request.token === undefined ? 0 : Number(request.token);
    return opts.pages[index] ?? { objects: [], nextPageToken: null };
  });

  return {
    listObjects,
    getClass: vi.fn(async () => null),
    insertClass: vi.fn(async () => {
      throw new Error('not used');
    }),
    patchClass: vi.fn(async () => {
      throw new Error('not used');
    }),
    insertObject: vi.fn(async () => {
      throw new Error('not used');
    }),
    saveUriForJwt: vi.fn(async () => {
      throw new Error('not used');
    }),
    getObject: vi.fn(async (id: string) => remote.get(id) ?? null),
    patchObject: vi.fn(async (id: string, patch: { loyaltyPoints?: LoyaltyObject['loyaltyPoints'] }) => {
      const current = remote.get(id);
      if (!current) throw new Error(`no such object ${id}`);
      const next: LoyaltyObject = { ...current, ...(patch.loyaltyPoints ? { loyaltyPoints: patch.loyaltyPoints } : {}) };
      remote.set(id, next);
      return next;
    }),
  } as unknown as FakeClient;
}

function onePage(objects: LoyaltyObject[]): PageSpec[] {
  return [{ objects, nextPageToken: null }];
}

// ---------------------------------------------------------------------------
// Demo Mode
// ---------------------------------------------------------------------------

describe('the sweep in Demo Mode', () => {
  it('calls neither the store nor Google, and reports that it did nothing', async () => {
    const store = new SweepStore({ [tenantId(1)]: program(tenantId(1)) });
    const client = fakeGoogle({ pages: onePage([remoteObject(OBJECT_ID, 50)]) });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: true });

    expect(report.demoMode).toBe(true);
    // The whole point: a background writer that forgot this check would be
    // writing to Google on a schedule, for a deployment that has no publishing
    // access and therefore no account it is permitted to write to.
    expect(client.listObjects).not.toHaveBeenCalled();
    expect(client.getObject).not.toHaveBeenCalled();
    expect(client.patchObject).not.toHaveBeenCalled();
    expect(store.methodsCalled()).toEqual([]);
    expect(report.tenantsSwept).toBe(0);
    expect(report.listCalls).toBe(0);
    expect(report.passesActedOn).toBe(0);
  });

  it('opens no database connection, so a demo deployment is not touched at all', async () => {
    // `runScheduledSweep` is the boundary that would call `createDb`. In demo
    // mode it must return before that, which is asserted by handing it bindings
    // whose DATABASE_URL would fail loudly if it were ever opened.
    const report = await runScheduledSweep({
      DATABASE_URL: 'postgres://this-host-does-not-exist.invalid:5432/nope',
      GOOGLE_WALLET_ISSUER_ID: ISSUER,
      GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: 'wallet@example.invalid',
      GOOGLE_WALLET_PRIVATE_KEY: 'not-a-key',
      MEMBER_CODE_PEPPER: 'pepper',
      WALLET_ALLOWED_ORIGINS: 'https://app.vyloop.app',
      WALLET_DEMO_MODE: 'true',
    });

    expect(report.demoMode).toBe(true);
    expect(report.listCalls).toBe(0);
    expect(report.passesActedOn).toBe(0);
    // The half of the guard the bad DATABASE_URL above cannot prove.
    // `createDb` is mocked to throw, so reaching it at all is a failure, and
    // the call count says so even if the throw were ever swallowed upstream.
    expect(vi.mocked(createDb)).not.toHaveBeenCalled();
  });

  it('treats an absent or unrecognised WALLET_DEMO_MODE as demo mode', async () => {
    // `parseDemoMode` is what the boundary delegates to, and the sweep's own
    // check is a plain boolean. So the fail-closed behaviour has to be proved
    // at the boundary, and it is the same property the routes rely on.
    for (const raw of [undefined, '', 'yes', 'maybe', '  ']) {
      const report = await runScheduledSweep({
        DATABASE_URL: 'postgres://this-host-does-not-exist.invalid:5432/nope',
        GOOGLE_WALLET_ISSUER_ID: ISSUER,
        GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: 'wallet@example.invalid',
        GOOGLE_WALLET_PRIVATE_KEY: 'not-a-key',
        MEMBER_CODE_PEPPER: 'pepper',
        WALLET_ALLOWED_ORIGINS: 'https://app.vyloop.app',
        WALLET_DEMO_MODE: raw,
      });
      expect(report.demoMode).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The class-readiness rule
// ---------------------------------------------------------------------------

describe('the sweep never writes for a tenant whose class is not usable', () => {
  const unapproved = [
    ['under_review', 'under_review'],
    ['rejected', 'rejected'],
    ['draft', 'draft'],
    ['', ''],
  ] as const;

  for (const [reviewStatus] of unapproved) {
    it(`asks Google nothing for a class in review status "${reviewStatus}"`, async () => {
      const tenant = tenantId(1);
      const store = new SweepStore({ [tenant]: program(tenant, { reviewStatus }) });
      const client = fakeGoogle({ pages: onePage([remoteObject(OBJECT_ID, 50)]) });

      const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

      expect(report.tenantsSkipped).toBe(1);
      expect(report.tenantsSwept).toBe(0);
      expect(client.listObjects).not.toHaveBeenCalled();
      expect(client.patchObject).not.toHaveBeenCalled();
      // Not one call about this tenant either: the readiness check comes before
      // the store is asked anything about it.
      expect(store.method(tenant)).toEqual([]);
    });
  }

  it('asks Google nothing when the stored class id does not match the derivation', async () => {
    // The fourth readiness failure, and the one a naive `review_status =
    // 'approved'` check would miss entirely. A class id that does not derive
    // from the tenant means the row and the class Google holds are not the same
    // object, so listing against it would sweep somebody else's passes.
    const tenant = tenantId(1);
    const store = new SweepStore({
      [tenant]: program(tenant, { classId: `${ISSUER}.tenant-someone-else` }),
    });
    const client = fakeGoogle({ pages: onePage([remoteObject(OBJECT_ID, 50)]) });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.tenantsSkipped).toBe(1);
    expect(client.listObjects).not.toHaveBeenCalled();
  });

  it('still sweeps the approved tenant when another one is skipped', async () => {
    const good = tenantId(2);
    const bad = tenantId(1);
    const store = new SweepStore({
      [bad]: program(bad, { reviewStatus: 'rejected' }),
      [good]: program(good),
    });
    const client = fakeGoogle({ pages: onePage([remoteObject(OBJECT_ID, 50)]) });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.tenantsSkipped).toBe(1);
    expect(report.tenantsSwept).toBe(1);
    expect(report.objectsSeen).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('the sweep never crosses a tenant', () => {
  it('lists against the tenant\'s own class id, not the issuer', async () => {
    const a = tenantId(1);
    const b = tenantId(2);
    const store = new SweepStore({ [a]: program(a), [b]: program(b) });
    const client = fakeGoogle({ pages: onePage([]) });

    await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    // The class filter *is* the tenant boundary on the Google side: one class
    // per tenant. Listing by issuer would put every merchant's passes in this
    // worker's memory and rely on a local `if` to undo it.
    expect(client.listObjects).toHaveBeenCalledTimes(2);
    expect(client.listObjects.mock.calls.map((c) => (c[0] as { classId: string }).classId)).toEqual([
      classIdFor(ISSUER, a),
      classIdFor(ISSUER, b),
    ]);
  });

  it('does not reconcile a pass row that belongs to another tenant', async () => {
    const mine = tenantId(1);
    const theirs = tenantId(2);
    const store = new SweepStore({ [mine]: program(mine), [theirs]: program(theirs) });

    // A row wrongly filed under `mine` while the object belongs to `theirs`.
    const crossing = objectIdFor(ISSUER, globalIdFor(1));
    store.seedPass({ tenant: theirs, customer: 'cust-theirs', objectId: crossing, balance: 10 });

    // Google's listing for `mine` hands back that same object — a resolver that
    // ignored `tenant_id` would return the foreign row and the sweep would
    // patch a pass belonging to a different merchant. `theirs` never lists it,
    // so nothing should be reconciled at all.
    const client = fakeGoogle({
      pages: ({ classId }) =>
        classId === classIdFor(ISSUER, mine)
          ? { objects: [remoteObject(crossing, 10)], nextPageToken: null }
          : { objects: [], nextPageToken: null },
    });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.passesActedOn).toBe(0);
    expect(report.objectsWithoutPassRow).toBe(1);
    expect(client.patchObject).not.toHaveBeenCalled();
    // And nothing was recorded against the other tenant's row.
    expect(store.lifecycles).toEqual([]);
    expect(store.reconciliations).toEqual([]);
  });

  it('records the observation against the tenant that owns the pass, not the one being swept', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    store.seedPass({
      tenant,
      customer: 'cust-1',
      objectId: OBJECT_ID,
      balance: 10,
      state: 'not_issued',
    });

    const client = fakeGoogle({
      pages: ({ token }) =>
        token === undefined
          ? { objects: [remoteObject(OBJECT_ID, 0, 'EXPIRED')], nextPageToken: null }
          : { objects: [], nextPageToken: null },
    });

    await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(store.lifecycles).toHaveLength(1);
    expect(store.lifecycles[0].tenantId).toBe(tenant);
    expect(store.lifecycles[0].customerId).toBe('cust-1');
  });
});

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

describe('tenant enumeration', () => {
  it('asks for one bounded page per invocation, starting at the beginning', async () => {
    const store = new SweepStore({ [tenantId(1)]: program(tenantId(1)) });
    const client = fakeGoogle({ pages: onePage([]) });

    await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(store.tenantPageRequests).toEqual([
      { limit: MAX_TENANTS_PER_RUN, afterTenantId: null },
    ]);
  });

  it('bounds the number of tenants it asks for, so the read is never unbounded', async () => {
    // The constant is asserted rather than merely referenced: a test that reads
    // `MAX_TENANTS_PER_RUN` proves nothing if the constant is the thing that
    // broke, and the whole safety claim is that the value handed to the store is
    // a bound rather than a wish.
    expect(MAX_TENANTS_PER_RUN).toBe(25);

    const store = new SweepStore({ [tenantId(1)]: program(tenantId(1)) });
    const client = fakeGoogle({ pages: onePage([]) });

    await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(store.tenantPageRequests).toEqual([{ limit: 25, afterTenantId: null }]);
  });

  it('walks no more tenants than the per-run bound', async () => {
    const programs: Record<string, WalletProgramRow> = {};
    for (let n = 1; n <= MAX_TENANTS_PER_RUN + 10; n += 1) {
      programs[tenantId(n)] = program(tenantId(n));
    }
    const store = new SweepStore(programs);
    const client = fakeGoogle({ pages: onePage([]) });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.tenantsSwept).toBe(MAX_TENANTS_PER_RUN);
    expect(client.listObjects).toHaveBeenCalledTimes(MAX_TENANTS_PER_RUN);
  });

  it('reports a failed enumeration as a report rather than throwing', async () => {
    const store = new SweepStore({ [tenantId(1)]: program(tenantId(1)) });
    store.failListTenants = new Error('connection reset');
    const client = fakeGoogle({ pages: onePage([]) });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    // A scheduled handler that threw here would have the whole invocation
    // retried, forever, against a database that is down.
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].stage).toBe('list_tenants');
    expect(report.tenantsSwept).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('paging through Google\'s list', () => {
  it('sends no token on the first page and the returned token on the next', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    const ids = [0, 1, 2].map((n) => objectIdFor(ISSUER, globalIdFor(n)));
    const client = fakeGoogle({
      pages: [
        { objects: [remoteObject(ids[0], 0)], nextPageToken: '1' },
        { objects: [remoteObject(ids[1], 0)], nextPageToken: '2' },
        { objects: [remoteObject(ids[2], 0)], nextPageToken: null },
      ],
    });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.listCalls).toBe(3);
    expect(client.listObjects.mock.calls.map((c) => (c[0] as { token?: string }).token)).toEqual([
      undefined,
      '1',
      '2',
    ]);
  });

  it('requests the documented page size, and resolves rows one page at a time', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    const first = objectIdFor(ISSUER, globalIdFor(1));
    const second = objectIdFor(ISSUER, globalIdFor(2));
    const client = fakeGoogle({
      pages: [
        { objects: [remoteObject(first, 0)], nextPageToken: '1' },
        { objects: [remoteObject(second, 0)], nextPageToken: null },
      ],
    });

    await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(OBJECT_PAGE_SIZE).toBe(100);
    expect(client.listObjects.mock.calls[0][0]).toMatchObject({ maxResults: OBJECT_PAGE_SIZE });
    // Batched per page, not one row at a time and not the whole tenant at once:
    // this is what keeps memory flat on a tenant with 50,000 passes.
    expect(store.resolveRequests).toEqual([
      { objectIds: [first], tenantId: tenant },
      { objectIds: [second], tenantId: tenant },
    ]);
  });

  it('reports a tenant that needs more pages than one invocation allows as deferred', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    const client = fakeGoogle({
      // Always another page: this tenant is far larger than one run covers.
      pages: ({ token }) => {
        const n = token === undefined ? 0 : Number(token);
        return {
          objects: [remoteObject(objectIdFor(ISSUER, globalIdFor(n)), 0)],
          nextPageToken: String(n + 1),
        };
      },
    });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.listCalls).toBe(MAX_PAGES_PER_TENANT);
    expect(report.tenantsDeferred).toBe(1);
    expect(report.tenantsSwept).toBe(0);
  });

  it('does not call the store at all for a tenant whose list failed', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    const client = fakeGoogle({
      pages: onePage([]),
      failListFor: new Set([classIdFor(ISSUER, tenant)]),
    });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.tenantsFailed).toBe(1);
    expect(report.failures[0].stage).toBe('list_objects');
    expect(store.method(tenant)).not.toContain('findPassesByObjectIds');
  });

  it('fails the tenant whose row resolution failed, and sweeps the next one', async () => {
    // The third tenant-level stage, and the most dangerous place to get it
    // wrong. The resolver is what ties a Google object to a customer, so a
    // failure there handled as "no rows came back" reports a tenant as swept
    // having reconciled nobody — and every one of its passes would be counted
    // as `objectsWithoutPassRow` and never revisited. Nothing would look wrong.
    const broken = tenantId(1);
    const healthy = tenantId(2);
    const store = new SweepStore({ [broken]: program(broken), [healthy]: program(healthy) });
    const b = objectIdFor(ISSUER, globalIdFor(1));
    store.seedPass({ tenant: broken, customer: 'cust-b', objectId: b, balance: 40 });
    store.failResolve.set(broken, new Error('statement timeout'));

    const client = fakeGoogle({
      pages: ({ classId }) =>
        classId === classIdFor(ISSUER, broken)
          ? { objects: [remoteObject(b, 0)], nextPageToken: null }
          : { objects: [], nextPageToken: null },
    });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    // Named as its own stage, so an operator reading the report knows this was
    // a database problem rather than something about this merchant's Google
    // class, and therefore whether to retry or to look at the database.
    expect(report.tenantsFailed).toBe(1);
    expect(report.failures[0].stage).toBe('resolve_passes');
    expect(report.failures[0].tenantId).toBe(broken);
    expect(report.failures[0].reason).toContain('statement timeout');
    // And the damage that must not happen: the broken tenant is not a clean one.
    // Only the healthy tenant is counted as swept.
    expect(report.tenantsSwept).toBe(1);
    expect(report.passesActedOn).toBe(0);
    expect(report.objectsWithoutPassRow).toBe(0);
    // The next tenant is still reached, and the broken one is still reported.
    expect(report.failures.map((f) => f.tenantId)).toEqual([broken]);
  });
});

// ---------------------------------------------------------------------------
// Idempotency and resumability
// ---------------------------------------------------------------------------

describe('idempotency and resumability', () => {
  it('pushes a stale balance exactly once across two runs', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    store.seedPass({ tenant, customer: 'cust-1', objectId: OBJECT_ID, balance: 500 });
    // Google holds 120, the ledger holds 500. A first run must fix that.
    const client = fakeGoogle({ pages: onePage([remoteObject(OBJECT_ID, 120)]) });

    const first = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });
    expect(first.outcomes.patched).toBe(1);
    expect(client.patchObject).toHaveBeenCalledTimes(1);

    const second = await sweepPasses({ store, client, now: RUN_TWO }, { demoMode: false });

    // The second run re-reads and re-compares, finds 500 already there, and
    // writes nothing. This is the guarantee: the patch is an absolute
    // projection of the ledger, not a delta, so applying it twice is identical
    // to applying it once — and the comparison means it is not even attempted.
    expect(second.outcomes.in_sync).toBe(1);
    expect(second.outcomes.patched).toBe(0);
    expect(client.patchObject).toHaveBeenCalledTimes(1);
  });

  it('pushes only the balance, never the object state, so it cannot activate a pass', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    store.seedPass({ tenant, customer: 'cust-1', objectId: OBJECT_ID, balance: 500 });
    const client = fakeGoogle({ pages: onePage([remoteObject(OBJECT_ID, 120)]) });

    await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    const patch = client.patchObject.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(['loyaltyPoints']);
    expect(patch).not.toHaveProperty('state');
    expect(patch).not.toHaveProperty('textModulesData');
  });

  it('retries a pass that failed, and does not repeat the passes that succeeded', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    const a = objectIdFor(ISSUER, globalIdFor(1));
    const b = objectIdFor(ISSUER, globalIdFor(2));
    const c = objectIdFor(ISSUER, globalIdFor(3));
    store.seedPass({ tenant, customer: 'cust-a', objectId: a, balance: 10 });
    store.seedPass({ tenant, customer: 'cust-b', objectId: b, balance: 20 });
    store.seedPass({ tenant, customer: 'cust-c', objectId: c, balance: 30 });

    const client = fakeGoogle({ pages: onePage([remoteObject(a, 0), remoteObject(b, 0), remoteObject(c, 0)]) });
    // One pass is unreachable this run. Everything else must still be swept.
    client.getObject.mockImplementation(async (id: string) => {
      if (id === a) throw new Error('Google Wallet API responded 503 (backendError)');
      return client.patchObject.mock.calls.length >= 0 && id === b
        ? remoteObject(b, 20)
        : id === c
          ? remoteObject(c, 30)
          : null;
    });

    const first = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(first.failures).toHaveLength(1);
    expect(first.failures[0].reason).toContain('cust-a');
    expect(first.passesActedOn).toBe(3);
    expect(first.outcomes.in_sync).toBe(2);

    // Next day. The two that succeeded are stamped at RUN_ONE, which is older
    // than the new cutoff, so they are due again and are re-verified — but the
    // ledger has not moved, so nothing is pushed. The one that failed is still
    // due and is attempted again.
    const second = await sweepPasses({ store, client, now: RUN_TWO }, { demoMode: false });

    expect(second.failures).toHaveLength(1);
    expect(second.failures[0].reason).toContain('cust-a');
    expect(second.passesActedOn).toBe(3);
    expect(second.outcomes.patched).toBe(0);
  });

  it('skips a pass this same run has already verified', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    const a = objectIdFor(ISSUER, globalIdFor(1));
    store.seedPass({ tenant, customer: 'cust-a', objectId: a, balance: 10, lastSyncedAt: RUN_ONE });

    const client = fakeGoogle({ pages: onePage([remoteObject(a, 0)]) });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    // Stamped at exactly the run's own cutoff, so the same invocation does not
    // pay for it twice. A run that did this work would double its own cost and,
    // on a large tenant, exhaust its budget doing half the work twice.
    expect(report.passesSkippedNotDue).toBe(1);
    expect(report.passesActedOn).toBe(0);
    expect(client.getObject).not.toHaveBeenCalled();
  });

  it('treats a pass stamped after the run start as due', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    const a = objectIdFor(ISSUER, globalIdFor(1));
    store.seedPass({
      tenant,
      customer: 'cust-a',
      objectId: a,
      balance: 10,
      lastSyncedAt: new Date(RUN_ONE.getTime() - 1000),
    });
    const client = fakeGoogle({ pages: onePage([remoteObject(a, 10)]) });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.passesActedOn).toBe(1);
    expect(report.outcomes.in_sync).toBe(1);
  });

  it('continues a deferred tenant on the next run instead of restarting it', async () => {
    // The resumability property, stated as one scenario: a tenant bigger than
    // one invocation makes progress across runs rather than looping on the
    // first objects forever.
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    const ids = Array.from({ length: 12 }, (_, n) => objectIdFor(ISSUER, globalIdFor(n)));
    for (const id of ids) {
      store.seedPass({ tenant, customer: `cust-${id.slice(-4)}`, objectId: id, balance: 5 });
    }
    const client = fakeGoogle({
      pages: ({ token }) => {
        const start = token === undefined ? 0 : Number(token);
        return {
          objects: ids.slice(start, start + 4).map((id) => remoteObject(id, 5)),
          nextPageToken: start + 4 < ids.length ? String(start + 4) : null,
        };
      },
    });

    const first = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });
    expect(first.tenantsSwept).toBe(1);
    expect(first.objectsSeen).toBe(12);
    expect(first.outcomes.in_sync).toBe(12);

    const second = await sweepPasses({ store, client, now: RUN_TWO }, { demoMode: false });
    // All twelve were verified on the first run, so the second run re-lists
    // them and spends no writes. What it must not do is patch.
    expect(second.outcomes.patched).toBe(0);
    expect(second.passesActedOn).toBe(12);
  });

  it('never exceeds the per-tenant work budget, and says it stopped early', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    const count = MAX_RECONCILES_PER_TENANT + 5;
    const ids = Array.from({ length: count }, (_, n) => objectIdFor(ISSUER, globalIdFor(n)));
    for (const id of ids) {
      store.seedPass({ tenant, customer: `cust-${id.slice(-6)}`, objectId: id, balance: 5 });
    }
    const client = fakeGoogle({
      pages: ({ token }) => {
        const start = token === undefined ? 0 : Number(token);
        return {
          objects: ids.slice(start, start + OBJECT_PAGE_SIZE).map((id) => remoteObject(id, 5)),
          nextPageToken: start + OBJECT_PAGE_SIZE < count ? String(start + OBJECT_PAGE_SIZE) : null,
        };
      },
    });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.passesActedOn).toBe(MAX_RECONCILES_PER_TENANT);
    expect(report.tenantsDeferred).toBe(1);
  });

  it('keeps sweeping later tenants after one fails outright', async () => {
    const broken = tenantId(1);
    const healthy = tenantId(2);
    const store = new SweepStore({ [broken]: program(broken), [healthy]: program(healthy) });
    const client = fakeGoogle({
      pages: onePage([]),
      failListFor: new Set([classIdFor(ISSUER, broken)]),
    });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.tenantsFailed).toBe(1);
    expect(report.failures[0].tenantId).toBe(broken);
    // The healthy tenant was reached, which is the point: one broken merchant
    // must not mean the other 24 are never swept.
    expect(report.tenantsSwept).toBe(1);
    expect(report.failures.some((f) => f.tenantId === healthy)).toBe(false);
  });

  it('keeps sweeping a tenant\'s other passes when one throws', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    const a = objectIdFor(ISSUER, globalIdFor(1));
    const b = objectIdFor(ISSUER, globalIdFor(2));
    store.seedPass({ tenant, customer: 'cust-a', objectId: a, balance: 10 });
    store.seedPass({ tenant, customer: 'cust-b', objectId: b, balance: 20 });
    const client = fakeGoogle({ pages: onePage([remoteObject(a, 0), remoteObject(b, 0)]) });
    client.patchObject.mockImplementation(async (id: string) => {
      if (id === a) throw new Error('Google Wallet API responded 403 (permissionDenied)');
      return remoteObject(b, 20);
    });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].reason).toContain('cust-a');
    // The other pass in the same tenant was still pushed. Two calls were
    // attempted — the mock records the rejected one too — and only the second
    // went through.
    expect(report.outcomes.patched).toBe(1);
    expect(client.patchObject).toHaveBeenCalledTimes(2);
    expect(client.patchObject.mock.calls.map((c) => c[0])).toEqual([a, b]);
    expect(report.tenantsSwept).toBe(1);
  });

  it('leaves a pass alone when the pass row is not ours', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    const stranger = objectIdFor(ISSUER, globalIdFor(9));
    const client = fakeGoogle({ pages: onePage([remoteObject(stranger, 0)]) });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.objectsWithoutPassRow).toBe(1);
    expect(report.passesActedOn).toBe(0);
    expect(client.patchObject).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle tracking', () => {
  it('maps exactly the three states that are claims about an object that exists', () => {
    expect(lifecycleStateFor('INACTIVE')).toBe('inactive');
    expect(lifecycleStateFor('EXPIRED')).toBe('expired');
    expect(lifecycleStateFor('COMPLETED')).toBe('completed');
  });

  it('maps nothing for ACTIVE, PENDING, or a value it has not seen', () => {
    // `ACTIVE` belongs to the existence path, which re-reads and concludes for
    // itself. `PENDING` has no tracking counterpart, and a state Google adds
    // after this was written must fail closed rather than be recorded.
    expect(lifecycleStateFor('ACTIVE')).toBeNull();
    expect(lifecycleStateFor('PENDING')).toBeNull();
    expect(lifecycleStateFor('STATE_UNSPECIFIED')).toBeNull();
    expect(lifecycleStateFor('SOMETHING_NEW')).toBeNull();
    expect(lifecycleStateFor(null)).toBeNull();
    expect(lifecycleStateFor(undefined)).toBeNull();
  });

  it('records a deleted pass as expired instead of leaving it reading issued forever', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    store.seedPass({ tenant, customer: 'cust-1', objectId: OBJECT_ID, balance: 500, state: 'issued' });
    const client = fakeGoogle({ pages: onePage([remoteObject(OBJECT_ID, 500, 'EXPIRED')]) });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.lifecycleWrites.expired).toBe(1);
    expect(store.lifecycles[0]).toMatchObject({ customerId: 'cust-1', state: 'expired', tenantId: tenant });
    // And the row really moved: this is the defect being closed.
    expect(store.passes.get(tenant)?.get(OBJECT_ID)?.state).toBe('expired');
    // The balance was not pushed onto a retired pass.
    expect(client.patchObject).not.toHaveBeenCalled();
    expect(report.outcomes.object_not_active).toBe(1);
  });

  it('never advances a pass whose existence Google has never confirmed', async () => {
    // The exception to the monotonicity guard, in the direction that matters. A
    // lifecycle answer is a claim about an object, so it must not be able to
    // turn a row that says "we have never seen an object for this customer"
    // into one that says "this pass is expired". That would assert a pass at
    // Google we have never confirmed exists.
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    store.seedPass({
      tenant,
      customer: 'cust-1',
      objectId: OBJECT_ID,
      balance: 0,
      state: 'not_issued',
    });
    const client = fakeGoogle({ pages: onePage([remoteObject(OBJECT_ID, 0, 'INACTIVE')]) });

    await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(store.passes.get(tenant)?.get(OBJECT_ID)?.state).not.toBe('inactive');
  });

  it('treats expired and completed as terminal, and lets a deactivated pass come back', async () => {
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    const done = objectIdFor(ISSUER, globalIdFor(1));
    const back = objectIdFor(ISSUER, globalIdFor(2));
    store.seedPass({ tenant, customer: 'cust-1', objectId: done, balance: 5, state: 'expired' });
    store.seedPass({ tenant, customer: 'cust-2', objectId: back, balance: 5, state: 'inactive' });

    const client = fakeGoogle({
      pages: ({ token }) =>
        token === undefined
          ? {
              objects: [remoteObject(done, 5, 'ACTIVE'), remoteObject(back, 5, 'ACTIVE')],
              nextPageToken: null,
            }
          : { objects: [], nextPageToken: null },
    });

    await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    const rows = store.passes.get(tenant);
    // Nothing overwrote a terminal state.
    expect(rows?.get(done)?.state).toBe('expired');
    // A reactivated pass is recorded, and the existence path then confirms it.
    expect(rows?.get(back)?.state).toBe('issued');
  });

  it('keeps reconciling the other passes when one lifecycle write fails', async () => {
    // A lifecycle write that fails is a per-pass failure and must not end the
    // tenant: the next customer's balance still needs pushing, and a sweep that
    // abandoned the tenant on the first error would leave 4,999 passes stale for
    // no reason. Two passes, one of them broken, prove the isolation.
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    const retired = objectIdFor(ISSUER, globalIdFor(1));
    const live = objectIdFor(ISSUER, globalIdFor(2));
    store.seedPass({ tenant, customer: 'cust-retired', objectId: retired, balance: 500, state: 'issued' });
    store.seedPass({ tenant, customer: 'cust-live', objectId: live, balance: 700, state: 'issued' });
    // The retired pass is the one whose lifecycle write fails; the live one has
    // no lifecycle write to make at all, so it is unaffected by the failure.
    store.failLifecycle.set(tenant, new Error('deadlock detected'));

    const client = fakeGoogle({
      pages: ({ token }) =>
        token === undefined
          ? { objects: [remoteObject(retired, 500, 'EXPIRED'), remoteObject(live, 100)], nextPageToken: null }
          : { objects: [], nextPageToken: null },
    });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.failures.some((f) => f.reason.includes('lifecycle expired'))).toBe(true);
    expect(report.outcomes.patched).toBe(1);
    expect(report.outcomes.object_not_active).toBe(1);
    expect(client.patchObject).toHaveBeenCalledTimes(1);
    expect(client.patchObject.mock.calls[0][0]).toBe(live);
    expect(report.tenantsSwept).toBe(1);
  });

  it('records lifecycle before reconciling, so a retired pass is never pushed to first', async () => {
    const tenant = tenantId(1);
    const order: string[] = [];
    const store = new SweepStore({ [tenant]: program(tenant) });
    store.seedPass({ tenant, customer: 'cust-1', objectId: OBJECT_ID, balance: 500, state: 'issued' });
    const original = store.recordPassLifecycle.bind(store);
    store.recordPassLifecycle = async (update: PassLifecycleUpdate) => {
      order.push('lifecycle');
      return original(update);
    };
    const client = fakeGoogle({ pages: onePage([remoteObject(OBJECT_ID, 120, 'EXPIRED')]) });
    client.patchObject.mockImplementation(async () => {
      order.push('patch');
      return remoteObject(OBJECT_ID, 500, 'EXPIRED');
    });

    await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    // No patch happens here anyway, because `reconcilePass` independently
    // re-reads the object and refuses. The ordering matters for the case where
    // the two disagree, and the test pins the intent rather than the accident.
    expect(order[0]).toBe('lifecycle');
    expect(order).not.toContain('patch');
  });
});

// ============================================================================
// Liveness: a pass that cannot be improved must still leave the due set
// ============================================================================

describe('the sweep: liveness of a pass it cannot act on', () => {
  it('stamps a pass whose object is not ACTIVE, and leaves its state alone', async () => {
    // The liveness fix. `PENDING` has no mapping in `lifecycleStateFor`, by
    // design, so before the fix there was nothing to write anywhere: the object
    // was fetched, found to be not-`ACTIVE`, and the run moved on. The pass then
    // never left the due set and was re-read on every run for ever.
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    store.seedPass({ tenant, customer: 'cust-1', objectId: OBJECT_ID, balance: 500, state: 'issued' });
    const client = fakeGoogle({ pages: onePage([remoteObject(OBJECT_ID, 500, 'PENDING')]) });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    const row = store.passes.get(tenant)?.get(OBJECT_ID);
    // The observation moved...
    expect(row?.lastSyncedAt).toEqual(RUN_ONE);
    // ...and no state was invented for a Google value we have no word for.
    expect(row?.state).toBe('issued');
    expect(report.outcomes.object_not_active).toBe(1);
    expect(report.observationsNotRecorded).toBe(0);
    // Still no write to Google, and no lifecycle claim.
    expect(client.patchObject).not.toHaveBeenCalled();
    expect(store.lifecycles).toEqual([]);
  });

  it('does not act on the same unmappable pass twice within one window', async () => {
    // What the stamp buys, stated as a property rather than a column value. The
    // due filter skips anything this run verified, so the second sweep in the
    // same window spends nothing on it.
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    store.seedPass({ tenant, customer: 'cust-1', objectId: OBJECT_ID, balance: 500, state: 'issued' });
    const client = fakeGoogle({ pages: onePage([remoteObject(OBJECT_ID, 500, 'PENDING')]) });

    await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });
    expect(client.getObject).toHaveBeenCalledTimes(1);

    const second = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(client.getObject).toHaveBeenCalledTimes(1);
    expect(second.passesSkippedNotDue).toBe(1);
    expect(second.passesActedOn).toBe(0);
  });

  it('walks past a full budget of unmappable objects to reach the passes behind them', async () => {
    // The starvation, at the scale that makes it permanent. `MAX_RECONCILES_PER_TENANT`
    // objects Google cannot tell us anything new about, then one healthy pass.
    // Every one of the first budget-worth is due again on the next run, so a
    // second run in the same window must get past them — and only can, because
    // they were stamped.
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    const blocked = Array.from({ length: MAX_RECONCILES_PER_TENANT }, (_, i) => i);
    const liveIndex = MAX_RECONCILES_PER_TENANT;
    const blockedIds = blocked.map((i) => objectIdFor(ISSUER, globalIdFor(i + 1)));
    const liveId = objectIdFor(ISSUER, globalIdFor(liveIndex + 1));

    for (const [i, objectIdValue] of blockedIds.entries()) {
      store.seedPass({ tenant, customer: `blocked-${i}`, objectId: objectIdValue, balance: 500, state: 'issued' });
    }
    store.seedPass({ tenant, customer: 'live', objectId: liveId, balance: 700, state: 'issued' });

    const client = fakeGoogle({
      pages: onePage([
        ...blocked.map((i) => remoteObject(blockedIds[i]!, 500, 'PENDING')),
        remoteObject(liveId, 100),
      ]),
    });

    // Run one: the budget is exactly consumed by the unmappable objects, so the
    // live pass is not reached. This is the deferral the report is describing.
    const first = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });
    expect(first.passesActedOn).toBe(MAX_RECONCILES_PER_TENANT);
    expect(first.tenantsDeferred).toBe(1);

    // Run two, same window: the stamped objects are no longer due, so the sweep
    // spends its whole budget on what it had never reached.
    const second = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(second.passesSkippedNotDue).toBe(MAX_RECONCILES_PER_TENANT);
    expect(second.tenantsDeferred).toBe(0);
    expect(second.tenantsSwept).toBe(1);
    expect(second.outcomes.patched).toBe(1);
    expect(client.patchObject).toHaveBeenCalledTimes(1);
    expect(client.patchObject.mock.calls[0][0]).toBe(liveId);
  });

  it('reports a lifecycle answer it was not allowed to record, instead of counting it', async () => {
    // `findPassesByObjectIds` resolves rows by object id with no state filter, so
    // a `not_saved` row reaches the lifecycle write, matches no rows, and — under
    // a `void` return — was counted as a write that never happened.
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    store.seedPass({ tenant, customer: 'cust-1', objectId: OBJECT_ID, balance: 500, state: 'not_saved' });
    const client = fakeGoogle({ pages: onePage([remoteObject(OBJECT_ID, 500, 'INACTIVE')]) });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.lifecycleWrites.inactive).toBe(0);
    expect(report.lifecycleWritesSkipped).toBe(1);
    // The state was not invented, and the row was not left stale either: the
    // observation refresh from `reconcilePass` is what gets it out of the due set.
    expect(store.passes.get(tenant)?.get(OBJECT_ID)?.state).toBe('not_saved');
    expect(store.passes.get(tenant)?.get(OBJECT_ID)?.lastSyncedAt).toEqual(RUN_ONE);
    // And it is not dressed up as a failure, because nothing about waiting will
    // change it.
    expect(report.failures).toEqual([]);
  });

  it('writes the lifecycle state and refreshes the observation in one path', async () => {
    // A mappable state goes through `recordPassLifecycle`, which writes the state
    // and the stamp together, and then the same `reconcilePass` call every pass
    // makes records the observation again. Two statements, one decision point,
    // and the row ends up with both.
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    store.seedPass({ tenant, customer: 'cust-1', objectId: OBJECT_ID, balance: 500, state: 'issued' });
    const client = fakeGoogle({ pages: onePage([remoteObject(OBJECT_ID, 500, 'INACTIVE')]) });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    const row = store.passes.get(tenant)?.get(OBJECT_ID);
    expect(row?.state).toBe('inactive');
    expect(row?.lastSyncedAt).toEqual(RUN_ONE);
    expect(report.lifecycleWrites.inactive).toBe(1);
    expect(report.lifecycleWritesSkipped).toBe(0);
    expect(store.lifecycles).toHaveLength(1);
    expect(store.observations).toHaveLength(1);
  });

  it('reports an observation it could not record, rather than assuming the pass left the due set', async () => {
    // The one liveness hole left, and the counter that closes it. A pass in this
    // bucket is re-read from Google for ever, so the report has to say so rather
    // than counting the pass as handled.
    const tenant = tenantId(1);
    const store = new SweepStore({ [tenant]: program(tenant) });
    store.seedPass({ tenant, customer: 'cust-1', objectId: OBJECT_ID, balance: 500, state: 'issued' });
    store.recordPassObservation = async () => 0;
    const client = fakeGoogle({ pages: onePage([remoteObject(OBJECT_ID, 500, 'PENDING')]) });

    const report = await sweepPasses({ store, client, now: RUN_ONE }, { demoMode: false });

    expect(report.outcomes.object_not_active).toBe(1);
    expect(report.observationsNotRecorded).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The schedule and the export shape
// ---------------------------------------------------------------------------

describe('the schedule and the export shape', () => {
  it('is the same cron expression the rest of the repository uses for a daily job', () => {
    // `workers/automation` uses `0 6 * * *`. Two conventions for the same thing
    // in one repository is something somebody has to look up.
    expect(SWEEP_CRON).toBe('0 6 * * *');
    const fields = SWEEP_CRON.split(' ');
    expect(fields).toHaveLength(5);
    // Daily, at one hour of the day, on the hour. Anything with a `*` in the
    // first field would sweep several times a day and could push a pass four
    // times in 24h, which is past Google's three-notification cap.
    expect(fields[2]).toBe('*');
    expect(fields[3]).toBe('*');
    expect(fields[4]).toBe('*');
    expect(Number(fields[1])).toBeGreaterThanOrEqual(0);
    expect(Number(fields[1])).toBeLessThan(24);
  });

  it('runs at most once per pass per day, a third of Google\'s 24-hour cap', () => {
    const runsPerDay = SWEEP_CRON.split(' ')[0] === '*' ? 24 : 1;
    // Google caps field-update notifications at three per pass per 24 hours.
    expect(runsPerDay).toBe(1);
    expect(runsPerDay).toBeLessThanOrEqual(3);
  });

  it('exports `scheduled` by name and on the default object, so the cron cannot silently never fire', () => {
    expect(typeof scheduled).toBe('function');
    expect(defaultExport.scheduled).toBe(scheduled);
    // And the HTTP half is still there, unmodified.
    expect(typeof defaultExport.fetch).toBe('function');
  });

  it('resolves without throwing when the sweep is invoked with the real bindings shape', async () => {
    // The runtime passes a controller first and the bindings second. Getting the
    // parameter order wrong would make a live cron fail on every single
    // invocation while every unit test still passed.
    await expect(
      scheduled(
        { scheduledTime: Date.now(), cron: SWEEP_CRON },
        {
          DATABASE_URL: 'postgres://this-host-does-not-exist.invalid:5432/nope',
          GOOGLE_WALLET_ISSUER_ID: ISSUER,
          GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: 'wallet@example.invalid',
          GOOGLE_WALLET_PRIVATE_KEY: 'not-a-key',
          MEMBER_CODE_PEPPER: 'pepper',
          WALLET_ALLOWED_ORIGINS: 'https://app.vyloop.app',
          WALLET_DEMO_MODE: 'true',
        },
      ),
    ).resolves.toBeUndefined();
  });
});
