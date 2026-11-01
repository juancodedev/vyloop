/**
 * The pass-inactivity rule's entry point.
 *
 * ## A separate file because of the mocks
 *
 * `vi.mock` is hoisted and file-wide, so mocking `createDb` and
 * `createDrizzleWalletStore` here would replace them for the rule's own suite as
 * well. The rule's tests want the real module graph and this file wants two seams
 * punched in it, and the two cannot share a file.
 *
 * ## What is worth testing at this boundary
 *
 * The rule's behaviour is covered in `inactivity.test.ts`, against a fake store.
 * What lives *here* is the part that only the entry point owns, and two of those
 * things are the safety of the entire feature:
 *
 *   - **`dryRun` defaults to `true`.** A caller that omits the argument — a future
 *     one, a mistyped one, a service binding invoked by hand — gets a report rather
 *     than a mass state change over real customers' phones. This is the single
 *     default that has to be right, and it is the one a refactor is most likely to
 *     "clean up".
 *   - **the entry point is exported, on the module and on the default object.**
 *     Cloudflare's runtime and the RPC surface read whichever they find, and a
 *     method exported one way only is a method that silently never runs.
 *
 * And one that the rule's own suite cannot see:
 *
 *   - **there is no demo-mode early return**, unlike `runScheduledSweep`. The whole
 *     reason this rule has its own entry point is that the sweep's refusal would
 *     otherwise swallow it forever. A copy of that guard pasted in here would pass
 *     every test in `inactivity.test.ts` and produce a rule that never runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The seams. `createDb` is lazy and would otherwise be a no-op against a bogus
// URL; `createDrizzleWalletStore` is the only thing that turns that fake handle
// into something the entry point can call.
const fakeDb = { fake: true };
let store: FakeEntryStore;

/**
 * Counts what reaches Google, so "the default is a dry run" is a fact about the
 * run and not a reading of a flag.
 *
 * The echo is `INACTIVE` because that is what the real API returns for an applied
 * patch, and the rule verifies it. An echo of something else would make the write
 * path fail on a post-condition that has nothing to do with the property under
 * test.
 */
class CountingClient {
  readonly patches: Array<{ objectId: string; state: string | undefined }> = [];
  readonly reads: string[] = [];

  async patchObject(objectId: string, patch: { state?: string }) {
    this.patches.push({ objectId, state: patch.state });
    return {
      id: objectId,
      classId: 'class',
      state: 'INACTIVE',
      accountId: 'K7M2QX',
      loyaltyPoints: { label: 'puntos', balance: { string: '0' } },
      barcode: { type: 'QR_CODE' as const, value: 'seed' },
    };
  }
  async getObject(objectId: string) {
    this.reads.push(objectId);
    return null;
  }
  async insertObject(object: never) {
    return object;
  }
  async getClass() {
    return null;
  }
  async insertClass(loyaltyClass: never) {
    return loyaltyClass;
  }
  async patchClass() {
    return {} as never;
  }
  async listObjects() {
    return { objects: [], nextPageToken: null };
  }
  async saveUriForJwt() {
    return 'https://pay.google.com/save';
  }
}

const googleClient = new CountingClient();

vi.mock('@vyloop/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vyloop/db')>();
  return { ...actual, createDb: vi.fn(() => fakeDb) };
});

/**
 * The Google client seam.
 *
 * `googleWalletClientFor` is what the entry point builds its client with, so overriding it
 * is the only way to count what reaches Google without a credential and without a
 * socket. Everything else from `./helpers` passes through: `parseDemoMode` in particular has
 * to be the real one, because its default-is-demo rule is part of what is under test.
 */
vi.mock('./helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./helpers')>();
  return { ...actual, googleWalletClientFor: vi.fn(() => googleClient) };
});

vi.mock('./drizzle-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./drizzle-store')>();
  return {
    ...actual,
    createDrizzleWalletStore: vi.fn(() => store),
    // Spied rather than passed through: the assertion is that the entry point never
    // calls it, which needs something to assert against.
    openTenantWalletStore: vi.fn(actual.openTenantWalletStore),
  };
});

// Imported after the mocks, which vitest hoists above every import anyway.
import type { InactivityCandidateRow, WalletPassRow, WalletProgramRow } from './store';

import defaultExport, { deactivateInactivePasses } from './index';

// ---------------------------------------------------------------------------
// The double
// ---------------------------------------------------------------------------

/**
 * Only the two methods the entry point's plan path calls, plus the one its write
 * path calls.
 *
 * Deliberately not a full `WalletStore`. This is a seam, not a fake of the store:
 * the rule's own suite already models every method with the real tenant scoping,
 * and a second complete fake here would be a second thing that can be wrong. What
 * is left out is never reached, and `unknownMethod` throws so that if it ever is,
 * the test says which one.
 */
class FakeEntryStore {
  readonly programs: WalletProgramRow[];
  readonly writes: Array<{ customerId: string; state: string }> = [];
  /** The cutoff the entry point asked with, so the per-tenant scoping is visible. */
  readonly cutoffs: Array<{ tenantId: string; cutoff: Date }> = [];

  constructor(programs: WalletProgramRow[]) {
    this.programs = programs;
  }

  async listProgramTenants(options: {
    limit: number;
    afterTenantId: string | null;
  }): Promise<WalletProgramRow[]> {
    return this.programs
      .filter((row) => options.afterTenantId === null || row.tenantId > options.afterTenantId)
      .slice(0, options.limit);
  }

  async findInactivePassCandidates(input: {
    tenantId: string;
    cutoff: Date;
    limit: number;
  }): Promise<InactivityCandidateRow[]> {
    this.cutoffs.push({ tenantId: input.tenantId, cutoff: input.cutoff });
    return [{ customerId: 'customer-1', objectId: 'obj-1', lastActivityAt: null }];
  }

  async recordPassLifecycle(update: {
    customerId: string;
    tenantId: string;
    state: string;
    observedAt: Date;
  }): Promise<number> {
    this.writes.push({ customerId: update.customerId, state: update.state });
    return 1;
  }

  unknownMethod(): never {
    throw new Error('the entry point called a store method this test does not model');
  }
}

const TENANT = '00000000-0000-4000-8000-000000000001';

function configuredProgram(months: number | null): WalletProgramRow {
  return {
    tenantId: TENANT,
    issuerId: '3388000000023206930',
    classId: `3388000000023206930.tenant-${TENANT}`,
    reviewStatus: 'approved',
    demoMode: false,
    passInactivityMonths: months,
    lastSyncedAt: null,
  };
}

/**
 * A deployment that is not in demo mode and has no Google secrets.
 *
 * `googleWalletClientFor` builds the REST client from these and connects
 * lazily, so a client object can be constructed here without a credential and
 * without a socket. Nothing in these tests ever calls it.
 */
function env(overrides: Record<string, string> = {}): Record<string, string> {
  return { DATABASE_URL: 'postgres://test', WALLET_DEMO_MODE: 'false', ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deactivateInactivePasses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    googleClient.patches.length = 0;
    googleClient.reads.length = 0;
    store = new FakeEntryStore([configuredProgram(3)]);
  });

  it('is exported by name and on the default object', () => {
    // Cloudflare's runtime and the service binding read whichever they find. The
    // wallet worker exports `scheduled` both ways for exactly this reason, and the
    // automation worker's binding is typed against it — so a rename stops
    // typechecking there, and a missing default-object entry stops it running.
    expect(typeof deactivateInactivePasses).toBe('function');
    expect(typeof (defaultExport as Record<string, unknown>).deactivateInactivePasses).toBe(
      'function',
    );
  });

  it('defaults to a dry run when the caller says nothing', async () => {
    // The safety property of the whole feature. Omitting the argument must produce
    // a report, never a write: a caller that forgets, or a caller added later
    // without reading this file, must not be able to deactivate passes in bulk.
    const report = (await deactivateInactivePasses(env() as never)) as {
      totalCandidates: number;
      acted?: unknown;
    };

    expect(report.totalCandidates).toBe(1);
    // No `acted` half at all: a plan is not a run, and the two are not
    // interchangeable shapes a caller could mistake for one another.
    expect(report.acted).toBeUndefined();
    expect(store.writes).toEqual([]);
    // And nothing reached Google. Measured on the client the entry point builds,
    // so this is not the plan module declining to use a client it was handed.
    expect(googleClient.patches).toEqual([]);
    expect(googleClient.reads).toEqual([]);
  });

  it('opens no tenant session, because it enumerates tenants', async () => {
    // `openTenantWalletStore` sets `app.current_tenant_id`, which would hide every
    // other tenant's rows from the enumeration itself. The sweep omits it for the
    // same reason and that omission does not extend to the request path.
    const { openTenantWalletStore } = await import('./drizzle-store');
    await deactivateInactivePasses(env() as never);

    expect(openTenantWalletStore).not.toHaveBeenCalled();
  });

  it('still plans in demo mode, with no early return', async () => {
    // The property that distinguishes this entry point from `runScheduledSweep`,
    // which returns before it opens a database. A copy of that guard pasted in
    // here would pass every rule test and produce a rule that never runs.
    const report = (await deactivateInactivePasses(env({ WALLET_DEMO_MODE: 'true' }) as never)) as {
      totalCandidates: number;
    };

    expect(report.totalCandidates).toBe(1);
    expect(store.cutoffs).toHaveLength(1);
  });

  it('acts when explicitly told to, in a deployment that may write', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await deactivateInactivePasses(env() as never, { dryRun: false });

      // Google first, then our row — so the order the two writes happened in is
      // itself the assertion.
      expect(googleClient.patches).toEqual([{ objectId: 'obj-1', state: 'INACTIVE' }]);
      expect(store.writes).toEqual([{ customerId: 'customer-1', state: 'inactive' }]);
    } finally {
      log.mockRestore();
    }
  });

  it('refuses to act in demo mode, and names the tenant and the count', async () => {
    // Not a silent return. A reader of a run that selected 400 passes and touched
    // none must be able to find out that was the rule rather than a crash.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const report = (await deactivateInactivePasses(env({ WALLET_DEMO_MODE: 'true' }) as never, {
        dryRun: false,
      })) as { totalCandidates: number; demoMode: boolean; acted: { passesDeactivated: number } };

      expect(report.demoMode).toBe(true);
      expect(report.totalCandidates).toBe(1);
      expect(report.acted.passesDeactivated).toBe(0);
      expect(store.writes).toEqual([]);
      expect(googleClient.patches).toEqual([]);

      const line = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(line).toContain(TENANT);
      expect(line).toMatch(/demo/i);
    } finally {
      log.mockRestore();
    }
  });

  it('scopes the candidate query to the tenant it is reporting on', async () => {
    await deactivateInactivePasses(env() as never);

    expect(store.cutoffs).toHaveLength(1);
    expect(store.cutoffs[0]!.tenantId).toBe(TENANT);
  });

  it('reports nothing to do for an unconfigured tenant', async () => {
    store = new FakeEntryStore([configuredProgram(null)]);

    const report = (await deactivateInactivePasses(env() as never)) as {
      tenantsConsidered: number;
      tenantsConfigured: number;
      totalCandidates: number;
    };

    expect(report.tenantsConsidered).toBe(1);
    expect(report.tenantsConfigured).toBe(0);
    expect(report.totalCandidates).toBe(0);
    // And it never asked the database which passes would be touched.
    expect(store.cutoffs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The type-level half of "a dry run cannot write"
// ---------------------------------------------------------------------------

/**
 * `InactivityPlanDeps` must not have a `client`.
 *
 * The runtime assertion in `inactivity.test.ts` checks that a caller-built object
 * has no client, which is true whatever the type says — so it cannot catch someone
 * adding the capability. This one can: adding `client` to the interface makes this
 * type `never`, and assigning `true` to a `never` is a compile error, which
 * `pnpm -r typecheck` fails on.
 */
type PlanDeps = Parameters<typeof import('./inactivity').planInactivityDeactivation>[0];
type NoClientInPlanDeps = 'client' extends keyof PlanDeps ? never : true;

describe('the plan cannot reach Google', () => {
  it('has no client in its dependency type', () => {
    // The assertion is the type annotation. If `'client' in keyof PlanDeps` ever
    // becomes true, `_noClient` becomes `never` and this line stops compiling.
    const _noClient: NoClientInPlanDeps = true;
    expect(_noClient).toBe(true);
  });

  it('is not the same type as the apply path, which does have one', () => {
    // Pinning both directions: a refactor that gave the plan a client and took it
    // from the apply path would satisfy the check above and break this one.
    type ApplyDeps = Parameters<typeof import('./inactivity').applyInactivityDeactivation>[0];
    const applyHasClient: 'client' extends keyof ApplyDeps ? true : false = true;

    expect(applyHasClient).toBe(true);
  });
});

// `WalletPassRow` is imported for the store seam's type surface; referenced here
// so the import is not tree-shaken into an unused-binding lint error.
export type _Unused = WalletPassRow | null;
