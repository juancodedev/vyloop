// The `vi.mock` factories below are hoisted above every import in this file, which
// is why the module under test is imported after them. Same shape as
// `reconcile-customer.test.ts`, and for the same reasons: three seams, and the
// orchestration under test is **not** mocked away.

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('./drizzle-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('./drizzle-store')>();
  return { ...original, createDrizzleWalletStore: vi.fn(), openTenantSession: vi.fn() };
});

// The real helpers, with the one function that can reach the network replaced.
// Without this, the first assertion here would attempt a real token exchange
// with Google, and the suite would be asserting on a DNS failure.
vi.mock('./helpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('./helpers')>();
  return { ...original, googleWalletClientFor: vi.fn() };
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { createDrizzleWalletStore, openTenantSession } from './drizzle-store';
import type { GoogleWalletClient, GoogleWalletErrorDetail } from './google-client';
import { GoogleWalletApiError } from './google-client';
import { googleWalletClientFor } from './helpers';
import { classIdFor } from './ids';
import type { WalletProgramRow, WalletStore, WalletTenantBrandingRow } from './store';

import { provisionClass } from './index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = '3388000000023206930';
const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const OTHER_TENANT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CLASS_ID = classIdFor(ISSUER, TENANT);

/** The one public door to `/brand/*`. See `apps/gateway/src/brand.ts`. */
const PUBLIC_BASE_URL = 'https://media.juancode.dev';
const BRAND_URL = `${PUBLIC_BASE_URL}/brand/${TENANT}.jpg`;

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
    WALLET_DEMO_MODE: 'true',
    WALLET_PUBLIC_BASE_URL: PUBLIC_BASE_URL,
  };
});

// ---------------------------------------------------------------------------
// The store
//
// Tenant predicates are honoured rather than stubbed: a fake that answers for
// any tenant would make the scoping assertions below pass for the wrong reason.
// Anything the happy path is not supposed to reach throws, so a provisioning
// step that grows a new dependency fails loudly.
// ---------------------------------------------------------------------------

interface FakeStore {
  store: WalletStore;
  findProgram: Mock;
  findTenantBranding: Mock;
  findProgramName: Mock;
  insertProgram: Mock;
}

function brandingRow(overrides: Partial<WalletTenantBrandingRow> = {}): WalletTenantBrandingRow {
  return { name: 'Café Central', country: 'CL', ...overrides };
}

function programRow(overrides: Partial<WalletProgramRow> = {}): WalletProgramRow {
  return {
    tenantId: TENANT,
    issuerId: ISSUER,
    classId: CLASS_ID,
    reviewStatus: 'draft',
    demoMode: true,
    lastSyncedAt: null,
    ...overrides,
  };
}

function fakeStore(
  overrides: {
    program?: WalletProgramRow | null;
    branding?: WalletTenantBrandingRow | null;
    programName?: string | null;
    insertFails?: boolean;
  } = {},
): FakeStore {
  const findProgram = vi.fn(async (tenantId: string) => {
    const row = overrides.program === undefined ? null : overrides.program;
    if (row === null) return null;
    return row.tenantId === tenantId ? row : null;
  });

  const findTenantBranding = vi.fn(async (tenantId: string) => {
    const row = overrides.branding === undefined ? brandingRow() : overrides.branding;
    if (row === null) return null;
    // `tenants.id` is the tenant, so a branding row is only ever this tenant's
    // when the store was asked for this tenant. The fake models that by
    // refusing any other id rather than by trusting the caller.
    return tenantId === TENANT ? row : null;
  });

  const findProgramName = vi.fn(async (tenantId: string) => {
    const name = overrides.programName === undefined ? 'Programa de Lealtad Café Central' : overrides.programName;
    return tenantId === TENANT ? name : null;
  });

  const insertProgram = vi.fn(async () => {
    if (overrides.insertFails === true) throw new Error('connection terminated unexpectedly');
  });

  const unused = (name: string) =>
    vi.fn(async (): Promise<never> => {
      throw new Error(`${name} is not part of provisioning and was not expected to be called`);
    });

  const store = {
    findProgram,
    findTenantBranding,
    findProgramName,
    insertProgram,
    findCustomer: unused('findCustomer'),
    findCustomerById: unused('findCustomerById'),
    findPointsCurrency: unused('findPointsCurrency'),
    findTierName: unused('findTierName'),
    latestBalance: unused('latestBalance'),
    isMemberCodeTaken: unused('isMemberCodeTaken'),
    claimMemberCode: unused('claimMemberCode'),
    recordPass: unused('recordPass'),
    findPass: unused('findPass'),
    recordPassReconciliation: unused('recordPassReconciliation'),
    recordPassLifecycle: unused('recordPassLifecycle'),
    recordPassObservation: unused('recordPassObservation'),
    listProgramTenants: unused('listProgramTenants'),
    findPassesByObjectIds: unused('findPassesByObjectIds'),
    updateProgramReviewStatus: unused('updateProgramReviewStatus'),
    setProgramDemoMode: unused('setProgramDemoMode'),
  } as unknown as WalletStore;

  return { store, findProgram, findTenantBranding, findProgramName, insertProgram };
}

// ---------------------------------------------------------------------------
// The client
//
// Stateful on purpose: a fake that cannot represent an existing class at Google
// makes the 409 idempotency assertion pass for the wrong reason.
// ---------------------------------------------------------------------------

interface FakeClient extends GoogleWalletClient {
  insertClass: Mock;
  getClass: Mock;
}

function apiError(status: number, code: string): GoogleWalletApiError {
  const errors: GoogleWalletErrorDetail[] = [
    { message: `google says ${code}`, reason: code, location: 'body' },
  ];
  return new GoogleWalletApiError(status, code, errors);
}

function fakeClient(
  options: {
    existsAtGoogle?: boolean;
    failWith?: GoogleWalletApiError | Error;
  } = {},
): FakeClient {
  let exists = options.existsAtGoogle ?? false;

  return {
    insertClass: vi.fn(async (loyaltyClass: { id: string }) => {
      if (options.failWith !== undefined) throw options.failWith;
      if (exists) throw apiError(409, 'alreadyExists');
      exists = true;
      return loyaltyClass as never;
    }),
    getClass: vi.fn(async (id: string) => (exists ? ({ id } as never) : null)),
    patchClass: vi.fn(async (): Promise<never> => {
      throw new Error('patchClass is not part of provisioning');
    }),
    getObject: vi.fn(async (): Promise<never> => {
      throw new Error('getObject is not part of provisioning');
    }),
    insertObject: vi.fn(async (): Promise<never> => {
      throw new Error('insertObject is not part of provisioning');
    }),
    patchObject: vi.fn(async (): Promise<never> => {
      throw new Error('patchObject is not part of provisioning');
    }),
    listObjects: vi.fn(async () => ({ objects: [], nextPageToken: null })),
    saveUriForJwt: vi.fn(async (): Promise<never> => {
      throw new Error('saveUriForJwt is not part of provisioning');
    }),
  } as unknown as FakeClient;
}

/** Wire the fakes into the two seams and run the entry point. */
function install(store: FakeStore, client: FakeClient, overrides: Record<string, unknown> = {}) {
  Object.assign(env, overrides);
  vi.mocked(createDrizzleWalletStore).mockReturnValue(store.store);
  vi.mocked(openTenantSession).mockResolvedValue({} as never);
  vi.mocked(googleWalletClientFor).mockReturnValue(client);

  return provisionClass({ tenantId: TENANT }, env as never);
}

// ============================================================================
// A brand new tenant
// ============================================================================

describe('provisionClass: a tenant with no Google class', () => {
  it('creates the class at Google and records the program row', async () => {
    const store = fakeStore();
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(outcome).toEqual({ kind: 'created', classId: CLASS_ID });
    expect(client.insertClass).toHaveBeenCalledTimes(1);
    expect(store.insertProgram).toHaveBeenCalledTimes(1);
  });

  it('sends the merchant branding, the country and the public logo URL', async () => {
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);

    // Every field here is one docs/11 records as required or as the thing Google
    // actually reads. `issuerName` alone produces a class whose header says
    // nothing about the business; `localizedIssuerName` is the field Google's
    // loyalty pass renders at the top.
    expect(client.insertClass).toHaveBeenCalledWith({
      id: CLASS_ID,
      issuerName: 'Café Central',
      localizedIssuerName: { defaultValue: { language: 'es-CL', value: 'Café Central' } },
      programName: 'Programa de Lealtad Café Central',
      reviewStatus: 'DRAFT',
      countryCode: 'CL',
      programLogo: { sourceUri: { uri: BRAND_URL } },
      homepageUri: { uri: `${PUBLIC_BASE_URL}/program`, description: 'Programa de lealtad' },
    });
  });

  it('uppercases the country code, because ISO 3166-1 alpha-2 is uppercase', async () => {
    // `tenants.country` is free text with no format constraint, so `cl` and `CL`
    // are the same country and must not produce two different classes.
    const store = fakeStore({ branding: brandingRow({ country: 'cl' }) });
    const client = fakeClient();

    await install(store, client);

    expect(client.insertClass).toHaveBeenCalledWith(
      expect.objectContaining({ countryCode: 'CL' }),
    );
  });

  it('points the logo at the gateway brand route, which is the only public door', async () => {
    // The R2 bucket is private, so this is the URL Google can fetch at all — and
    // it resolves to the platform default for a tenant with no upload of its own,
    // which is the case signup produces.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);

    const payload = client.insertClass.mock.calls[0]![0] as { programLogo: { sourceUri: { uri: string } } };
    expect(payload.programLogo.sourceUri.uri).toBe(`https://media.juancode.dev/brand/${TENANT}.jpg`);
  });

  it('reads the branding from the tenant and its loyalty program, for this tenant only', async () => {
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);

    expect(store.findTenantBranding).toHaveBeenCalledWith(TENANT);
    expect(store.findProgramName).toHaveBeenCalledWith(TENANT);
  });

  it('opens a tenant session first, because the program row is RLS-keyed on it', async () => {
    // `tenant_wallet_programs` reads `app.current_tenant_id`. Write the row
    // without the session and, the day the policy is enabled, the INSERT is a
    // silent zero-row — an unprovisioned tenant with no error anywhere.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);

    expect(openTenantSession).toHaveBeenCalledWith('postgres://mock', TENANT);
  });

  it('records the row in draft, in demo mode, keyed to the class it just created', async () => {
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);

    // `draft` is written explicitly rather than left to the column default,
    // which is `'none'` — a value that means "this tenant has no class yet" and
    // would fail closed on the pass route for a class that does exist.
    expect(store.insertProgram).toHaveBeenCalledWith({
      tenantId: TENANT,
      issuerId: ISSUER,
      classId: CLASS_ID,
      reviewStatus: 'draft',
      demoMode: true,
    });
  });

  it('honours a configured public base URL over the default', async () => {
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client, { WALLET_PUBLIC_BASE_URL: 'https://media.staging.juancode.dev/' });

    const payload = client.insertClass.mock.calls[0]![0] as {
      programLogo: { sourceUri: { uri: string } };
      homepageUri: { uri: string };
    };
    // The trailing slash of the var is not allowed to double up in the path.
    expect(payload.programLogo.sourceUri.uri).toBe(`https://media.staging.juancode.dev/brand/${TENANT}.jpg`);
    expect(payload.homepageUri.uri).toBe('https://media.staging.juancode.dev/program');
  });
});

// ============================================================================
// The order. This is the part that is easy to "simplify" into a lie.
// ============================================================================

describe('provisionClass: Google is written before the row, or not at all', () => {
  it('records nothing when Google refuses the class', async () => {
    // The whole reason the order is Google-then-row. A row written first would
    // declare a class Google does not have, `classReadinessFor` would answer
    // `ok: true`, and the failure would surface as a customer's pass failing to
    // save — long after the request that caused it returned 201.
    const store = fakeStore();
    const client = fakeClient({ failWith: apiError(503, 'UNAVAILABLE') });

    const outcome = await install(store, client);

    expect(store.insertProgram).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'failed', code: 'google_rejected' });
  });

  it('reports the Google failure as a typed outcome rather than a loose string', async () => {
    const store = fakeStore();
    const client = fakeClient({ failWith: apiError(400, 'invalidField') });

    const outcome = await install(store, client);

    // A caller branches on `code`. The message is for a human at 03:00 and is
    // allowed to be prose; the code is not.
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') throw new Error('expected a failed outcome');
    expect(typeof outcome.code).toBe('string');
    expect(outcome.message).toContain('invalidField');
  });

  it('records nothing when the token exchange itself fails', async () => {
    const store = fakeStore();
    const client = fakeClient({ failWith: new Error('Could not obtain a Google Wallet access token') });

    const outcome = await install(store, client);

    expect(store.insertProgram).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'failed', code: 'google_rejected' });
  });

  it('surfaces a failure to write the row, because that is the retry that cleans up', async () => {
    // The class now exists at Google with no row pointing at it: an orphan. That
    // is the deliberately survivable direction — the retry sees the 409 and
    // writes the row. Silently reporting success here would leave the orphan for
    // ever, because nothing would come back.
    const store = fakeStore({ insertFails: true });
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(client.insertClass).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'row_write_failed' });
  });
});

// ============================================================================
// Idempotency
// ============================================================================

describe('provisionClass: it is safe to run twice', () => {
  it('asks Google for nothing when the row already exists', async () => {
    // Not an optimisation: `insertClass` on an existing id is a 409, so a retry
    // that skips the check depends on a Google error code for correctness.
    const store = fakeStore({ program: programRow() });
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(client.insertClass).not.toHaveBeenCalled();
    expect(store.insertProgram).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'already_provisioned', classId: CLASS_ID });
  });

  it('reports the class the existing row names, not one derived again', async () => {
    // A row whose `class_id` disagrees with the formula is a data defect, and
    // the caller is told what is stored so it can be found rather than being
    // handed a re-derived id that looks fine.
    const storedClassId = `${ISSUER}.tenant-legacy-${TENANT}`;
    const store = fakeStore({ program: programRow({ classId: storedClassId }) });
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(outcome).toEqual({ kind: 'already_provisioned', classId: storedClassId });
  });

  it('records the row when Google answers 409, which is the retry after a half-finished run', async () => {
    const store = fakeStore();
    const client = fakeClient({ existsAtGoogle: true });

    const outcome = await install(store, client);

    expect(store.insertProgram).toHaveBeenCalledWith(
      expect.objectContaining({ classId: CLASS_ID, reviewStatus: 'draft' }),
    );
    expect(outcome).toEqual({ kind: 'already_exists', classId: CLASS_ID });
  });
});

// ============================================================================
// Data that cannot produce a class
// ============================================================================

describe('provisionClass: it refuses rather than invents', () => {
  it('reports a tenant it cannot read, without asking Google', async () => {
    // The row exists the instant signup commits, so this is a lost race or a
    // wrong id, not an ordinary state. Guessing a name would put fake branding
    // in front of a real customer.
    const store = fakeStore({ branding: null });
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(outcome).toMatchObject({ kind: 'failed', code: 'tenant_not_found' });
    expect(client.insertClass).not.toHaveBeenCalled();
  });

  it('reports a tenant with no loyalty program', async () => {
    // A loyalty program is configured separately from a Google class, so this is
    // a real state — but there is no program name to build a class from, and
    // Google requires one.
    const store = fakeStore({ programName: null });
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(outcome).toMatchObject({ kind: 'failed', code: 'loyalty_program_not_found' });
    expect(client.insertClass).not.toHaveBeenCalled();
    expect(store.insertProgram).not.toHaveBeenCalled();
  });

  it('reports a blank tenant name as a payload it refuses to build', async () => {
    // `buildLoyaltyClass` throws a plain `Error` for this. Letting it escape
    // would cross the RPC boundary as an untyped throw, so it is mapped to a
    // code the caller can branch on.
    const store = fakeStore({ branding: brandingRow({ name: '   ' }) });
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(outcome).toMatchObject({ kind: 'failed', code: 'class_payload_invalid' });
    expect(client.insertClass).not.toHaveBeenCalled();
    expect(store.insertProgram).not.toHaveBeenCalled();
  });

  it('scopes every read and the write to the tenant it was asked about', async () => {
    // A provisioning step that read or wrote without naming the tenant would
    // create a class for one business and a row pointing at it for another, and
    // every assertion above would still pass.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);

    expect(store.findProgram).not.toHaveBeenCalledWith(OTHER_TENANT);
    expect(store.findTenantBranding).not.toHaveBeenCalledWith(OTHER_TENANT);
    expect(store.findProgramName).not.toHaveBeenCalledWith(OTHER_TENANT);
    expect(store.insertProgram).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
    );
  });
});
