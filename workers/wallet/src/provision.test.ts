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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { createDrizzleWalletStore, openTenantSession } from './drizzle-store';
import type { GoogleWalletClient, GoogleWalletErrorDetail } from './google-client';
import { GoogleWalletApiError } from './google-client';
import { googleWalletClientFor } from './helpers';
import { classIdFor } from './ids';
import type { ProvisionFailureCode } from './provision';
import type { WalletProgramRow, WalletStore, WalletTenantBrandingRow } from './store';

import { provisionClass } from './index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = '3388000000023206930';
const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const OTHER_TENANT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CLASS_ID = classIdFor(ISSUER, TENANT);

/**
 * Three origins, and they are not interchangeable.
 *
 * `media` and `web` are both the gateway today — one origin serving `/brand/*`
 * and `/p/*` — and stay separate vars because they are separate consumers whose
 * histories differ. `customerWeb` is genuinely another host: the pass's links
 * point at `apps/customer-web` routes.
 *
 * See `apps/gateway/src/brand.ts` and `apps/gateway/src/merchant-page.ts`.
 */
const MEDIA_BASE_URL = 'https://media.juancode.dev';
const WEB_BASE_URL = 'https://media.juancode.dev';
const CUSTOMER_WEB_BASE_URL = 'https://vyloop-customer-web.pages.dev';
const CALLBACK_BASE_URL = 'https://media.juancode.dev';
const BRAND_URL = `${MEDIA_BASE_URL}/brand/${TENANT}.jpg`;

/** The tenant's real slug — `tenants.slug`, read, never derived from the name. */
const SLUG = 'cafe-central';

/** The gateway's per-merchant page: what `homepageUri` now points at. */
const PROGRAM_URL = `${WEB_BASE_URL}/p/${SLUG}`;

/** The endpoint Google POSTs saves and deletes to, per class. */
const CALLBACK_URL = `${CALLBACK_BASE_URL}/v1/wallet/google/callback`;

/** Next.js `app/` directory, for the "this route exists" assertion. */
const CUSTOMER_WEB_APP = join(__dirname, '..', '..', '..', 'apps', 'customer-web', 'app');

/** The gateway's route table, for the "does this route exist" assertion. */
const GATEWAY_INDEX = join(__dirname, '..', '..', '..', 'apps', 'gateway', 'src', 'index.ts');

/** The gateway's robots module, which is where it declares the callback path. */
const GATEWAY_ROBOTS = join(__dirname, '..', '..', '..', 'apps', 'gateway', 'src', 'robots.ts');

/**
 * The callback path as the **gateway** declares it, read by name.
 *
 * Read from `robots.ts` rather than matched inside `index.ts` because the
 * gateway now states this path exactly once: `index.ts` keys both the auth
 * exemption and the anonymous rate limit on the constant instead of repeating the
 * string, which is the whole point of the constant. What this test exists to hold
 * is that the URL handed to Google is the path the gateway declares — so it reads
 * the declaration, wherever the package chooses to put it, instead of depending
 * on a literal appearing somewhere specific.
 *
 * `apps/gateway/src/wallet-callback-path.contract.test.ts` is the mirror of this
 * assertion, running from the other side.
 */
function gatewayDeclaredCallbackPath(): string | undefined {
  const source = readFileSync(GATEWAY_ROBOTS, 'utf8');
  return /export const WALLET_CALLBACK_PATH = '([^']*)'/.exec(source)?.[1];
}

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
    WALLET_MEDIA_BASE_URL: MEDIA_BASE_URL,
    WALLET_WEB_BASE_URL: WEB_BASE_URL,
    WALLET_CUSTOMER_WEB_BASE_URL: CUSTOMER_WEB_BASE_URL,
    WALLET_CALLBACK_BASE_URL: CALLBACK_BASE_URL,
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
  findPromoCopy: Mock;
  insertProgram: Mock;
}

/**
 * The tenant's branding row.
 *
 * `slug` is the tenant's own — `tenants.slug` is `unique`, so two businesses
 * named "Café Central" do not both end up at `cafe-central`. It is set here as a
 * distinct value from the derived name precisely so a test can tell a read slug
 * from a recomputed one.
 */
function brandingRow(overrides: Partial<WalletTenantBrandingRow> = {}): WalletTenantBrandingRow {
  return { name: 'Café Central', country: 'CL', slug: SLUG, ...overrides };
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
    /** `loyalty_programs.promo_copy`. `null` is the default. */
    promoCopy?: string | null;
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

  // Absent by default, which is the honest default: a merchant who has written
  // no promo must get a class with no promo row rather than one carrying a
  // sentence nobody wrote. Tests that care pass `promoCopy` explicitly.
  const findPromoCopy = vi.fn(async (tenantId: string) => {
    const promo = overrides.promoCopy ?? null;
    return tenantId === TENANT ? promo : null;
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
    findPromoCopy,
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
    listTenantsWithoutProgram: unused('listTenantsWithoutProgram'),
    findPassesByObjectIds: unused('findPassesByObjectIds'),
    updateProgramReviewStatus: unused('updateProgramReviewStatus'),
    setProgramDemoMode: unused('setProgramDemoMode'),
  } as unknown as WalletStore;

  return {
    store,
    findProgram,
    findTenantBranding,
    findProgramName,
    findPromoCopy,
    insertProgram,
  };
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

/**
 * Wire the fakes into the two seams and run the entry point.
 *
 * An override of `undefined` *removes* the var rather than setting it to
 * undefined, so a test can exercise the documented default. `Object.assign`
 * alone would leave the previous value in place and quietly test the wrong
 * thing.
 */
function install(store: FakeStore, client: FakeClient, overrides: Record<string, unknown> = {}) {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
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
      homepageUri: { uri: PROGRAM_URL, description: 'Programa de lealtad' },
      // The one channel that reports a save or a delete at all. Without it,
      // `customer_wallet_passes.state` can only ever be inferred by asking Google
      // whether an object exists, which cannot tell "never opened the app" from
      // "deleted the pass".
      callbackOptions: { url: CALLBACK_URL },
      // The merchant wrote no promo in this fixture, so there is no promo row.
      linksModuleData: {
        uris: [
          { uri: `${CUSTOMER_WEB_BASE_URL}/profile`, description: 'Ver mi perfil' },
          { uri: `${CUSTOMER_WEB_BASE_URL}/profile/history`, description: 'Mi historial' },
        ],
      },
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

  it('honours a configured media base URL for the logo, without touching the homepage', async () => {
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client, { WALLET_MEDIA_BASE_URL: 'https://media.staging.juancode.dev/' });

    const payload = client.insertClass.mock.calls[0]![0] as {
      programLogo: { sourceUri: { uri: string } };
      homepageUri: { uri: string };
    };
    // The trailing slash of the var is not allowed to double up in the path.
    expect(payload.programLogo.sourceUri.uri).toBe(
      `https://media.staging.juancode.dev/brand/${TENANT}.jpg`,
    );
    // And a staging media host must not become the customer's homepage.
    expect(payload.homepageUri.uri).toBe(PROGRAM_URL);
  });

  it('honours a configured web base URL for the homepage, without touching the logo', async () => {
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client, { WALLET_WEB_BASE_URL: 'https://staging-customer.pages.dev/' });

    const payload = client.insertClass.mock.calls[0]![0] as {
      programLogo: { sourceUri: { uri: string } };
      homepageUri: { uri: string };
    };
    expect(payload.homepageUri.uri).toBe(`https://staging-customer.pages.dev/p/${SLUG}`);
    expect(payload.programLogo.sourceUri.uri).toBe(BRAND_URL);
  });
});

// ============================================================================
// Two hosts, not one
//
// The bug these exist for: a single var treated two different hosts as
// interchangeable, so `homepageUri` was built from the media host and pointed
// at a 404. Google opens `homepageUri` during review and rejects the class when
// it does not resolve (docs/11: the most common rejection reason), so the
// previous shape produced classes Google would refuse.
// ============================================================================

describe('provisionClass: the logo host and the homepage host cannot cross', () => {
  it('does not send the media host as the homepage, or the web host as the logo', async () => {
    // Distinct hosts on purpose: with one var feeding both fields, or with the
    // two fields' parsers transposed, either assertion below fails. A test using
    // one host for both would pass against the exact bug it is meant to catch.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client, {
      WALLET_MEDIA_BASE_URL: 'https://media.invalid-host.test',
      WALLET_WEB_BASE_URL: 'https://web.invalid-host.test',
    });

    const payload = client.insertClass.mock.calls[0]![0] as {
      programLogo: { sourceUri: { uri: string } };
      homepageUri: { uri: string };
    };

    expect(payload.programLogo.sourceUri.uri).toBe(
      `https://media.invalid-host.test/brand/${TENANT}.jpg`,
    );
    expect(payload.homepageUri.uri).toBe(`https://web.invalid-host.test/p/${SLUG}`);
  });

  it('reads each origin from its own var, so the logo and the homepage cannot be swapped', async () => {
    // Stated as "each came from its own var" rather than "the origins differ",
    // because they no longer differ: `homepageUri` moved to the gateway, so both
    // resolve to `media.juancode.dev`. The assertion this replaces was host
    // inequality, and it would have passed against two *transposed parsers* —
    // which is the swap that actually cost a class review. Asserting where each
    // value was read from is what catches that.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client, {
      WALLET_MEDIA_BASE_URL: 'https://media.invalid-host.test',
      WALLET_WEB_BASE_URL: 'https://web.invalid-host.test',
    });

    const payload = client.insertClass.mock.calls[0]![0] as {
      programLogo: { sourceUri: { uri: string } };
      homepageUri: { uri: string };
      linksModuleData: { uris: { uri: string }[] };
    };

    expect(new URL(payload.programLogo.sourceUri.uri).origin).toBe(
      'https://media.invalid-host.test',
    );
    expect(new URL(payload.homepageUri.uri).origin).toBe('https://web.invalid-host.test');
    // And the links come from neither — that is the third var.
    for (const link of payload.linksModuleData.uris) {
      expect(new URL(link.uri).origin).toBe(CUSTOMER_WEB_BASE_URL);
    }
  });

  it('defaults both gateway origins to one host, because the gateway serves both routes', async () => {
    // A fact about the deployment rather than about correctness: `/brand/*` and
    // `/p/*` are both gateway routes. The vars stay separate because either may
    // have to move without the other, which the previous test pins.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client, {
      WALLET_MEDIA_BASE_URL: undefined,
      WALLET_WEB_BASE_URL: undefined,
    });

    const payload = client.insertClass.mock.calls[0]![0] as {
      programLogo: { sourceUri: { uri: string } };
      homepageUri: { uri: string };
    };

    expect(new URL(payload.programLogo.sourceUri.uri).origin).toBe(
      new URL(payload.homepageUri.uri).origin,
    );
  });

  it('defaults the homepage to the page that actually exists, on the gateway', async () => {
    // The regression this replaces, and why the default changed.
    //
    // The previous default pointed `homepageUri` at the customer web's
    // `/program`. The dashboard is worse still: a `next-on-pages` static export
    // whose whole page is 9,638 bytes of which **18** are text, so a reviewer
    // opening it reads a `<title>` and nothing else.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client, {
      WALLET_MEDIA_BASE_URL: undefined,
      WALLET_WEB_BASE_URL: undefined,
      WALLET_CUSTOMER_WEB_BASE_URL: undefined,
    });

    const payload = client.insertClass.mock.calls[0]![0] as {
      homepageUri: { uri: string };
      programLogo: { sourceUri: { uri: string } };
    };

    expect(payload.homepageUri.uri).toBe(`https://media.juancode.dev/p/${SLUG}`);
    // The logo's default is unchanged and still the gateway's brand route.
    expect(payload.programLogo.sourceUri.uri).toBe(BRAND_URL);
  });

  it('points the homepage at a route the gateway source actually serves', async () => {
    // Asserted against the filesystem rather than against this file's own
    // constant, for the reason the links are: a route renamed in `apps/gateway`
    // would otherwise leave every class pointing at a 404 on the one field Google
    // rejects over, with every unit test green.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);

    const payload = client.insertClass.mock.calls[0]![0] as { homepageUri: { uri: string } };
    const route = new URL(payload.homepageUri.uri).pathname;

    expect(route).toBe(`/p/${SLUG}`);
    expect(gatewayServesMerchantPageRoute()).toBe(true);
  });

  // ==========================================================================
  // The minimum viable pass: what the comensal actually sees
  // ==========================================================================

  it('carries the merchant promo copy onto the class, from the program row', async () => {
    // The copy is per-merchant, so it belongs on the class: Google's own
    // documentation says class and object text modules are both displayed (10
    // each), and a change of promotion is then one patch rather than one per
    // customer.
    const store = fakeStore({ promoCopy: '¡Cada 10 sellos, un burger gratis!' });
    const client = fakeClient();

    await install(store, client);

    const payload = client.insertClass.mock.calls[0]![0] as {
      textModulesData: { id: string; header: string; body: string }[];
    };
    expect(payload.textModulesData).toEqual([
      { id: 'PROMO_COPY', header: 'Info', body: '¡Cada 10 sellos, un burger gratis!' },
    ]);
  });

  it('sends no promo row for a merchant who wrote none', async () => {
    // Omitted, never substituted. A default sentence here would be a merchant's
    // card reading words they never wrote, in front of a real comensal.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);

    const payload = client.insertClass.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.textModulesData).toBeUndefined();
    expect(store.findPromoCopy).toHaveBeenCalledWith(TENANT);
  });

  it('carries the pass links as linksModuleData, pointing at routes that exist', async () => {
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);

    const payload = client.insertClass.mock.calls[0]![0] as {
      linksModuleData: { uris: { uri: string; description?: string }[] };
    };
    const uris = payload.linksModuleData.uris.map((link) => link.uri);

    expect(uris).toEqual([
      `${CUSTOMER_WEB_BASE_URL}/profile`,
      `${CUSTOMER_WEB_BASE_URL}/profile/history`,
    ]);
    // Every path is asserted against the filesystem, not against this list: a
    // route that was renamed would otherwise produce a link that 404s in the
    // comensal's hand, which is the `homepageUri` defect at a different URL.
    for (const uri of uris) {
      expect(customerWebRouteExists(new URL(uri).pathname)).toBe(true);
    }
  });

  it('builds the links from the customer web, never from a gateway host', async () => {
    // `/profile` and `/profile/history` are `apps/customer-web` routes. The
    // gateway serves `/brand/*` and `/p/*` and neither of these, so a link built
    // from either gateway origin is a 404 in the customer's hand — the same
    // defect that cost a class review over `homepageUri`, at a different URL.
    //
    // This is the assertion that forced a third var: `WALLET_WEB_BASE_URL` and
    // `WALLET_MEDIA_BASE_URL` are the same host, so "build the links from the web
    // host" would have been a 404 with the tests green.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);

    const payload = client.insertClass.mock.calls[0]![0] as {
      linksModuleData: { uris: { uri: string }[] };
    };
    for (const link of payload.linksModuleData.uris) {
      const origin = new URL(link.uri).origin;
      expect(origin).toBe(CUSTOMER_WEB_BASE_URL);
      expect(origin).not.toBe(MEDIA_BASE_URL);
      expect(origin).not.toBe(WEB_BASE_URL);
    }
  });

  it('honours a configured customer-web var without moving the homepage', async () => {
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client, {
      WALLET_CUSTOMER_WEB_BASE_URL: 'https://staging-customer.pages.dev/',
    });

    const payload = client.insertClass.mock.calls[0]![0] as {
      homepageUri: { uri: string };
      linksModuleData: { uris: { uri: string }[] };
    };
    expect(payload.linksModuleData.uris[0]!.uri).toBe(
      'https://staging-customer.pages.dev/profile',
    );
    // A staging customer web must not become the customer's homepage.
    expect(payload.homepageUri.uri).toBe(PROGRAM_URL);
  });

  it('offers no link that promises one thing and delivers another', async () => {
    // `/confirm` exists and says "¡Gracias, {name}!" — a registration
    // confirmation. Labelling it "Actualizar tarjeta" is the `homepageUri` bug
    // at a different URL: the link exists, so nothing fails loudly.
    //
    // And there is no referral link, because `referrals` has no per-customer
    // code and `customers.member_code` is a member code, not a referral one.
    // Labelling it as a referral code would lie to the comensal on their own
    // card.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);

    const payload = client.insertClass.mock.calls[0]![0] as {
      linksModuleData: { uris: { uri: string; description?: string }[] };
    };
    const described = payload.linksModuleData.uris.map((link) => `${link.uri} ${link.description}`);

    expect(described.join('\n')).not.toMatch(/confirm/i);
    expect(described.join('\n')).not.toMatch(/referid|referral|invita/i);
    expect(described.join('\n')).not.toMatch(/actualizar/i);
  });

  it('emits no heroImage, because a placeholder filename renders as a broken asset', async () => {
    // Google fetches `heroImage` itself, so a URL that does not resolve is a
    // broken band across the top of the card. There is no image generation in
    // this repository, so every available URL would fail today.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);

    const payload = client.insertClass.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('heroImage');
  });

  it('emits no issuerLogo, which Google silently discards on a loyalty class', async () => {
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);

    const payload = client.insertClass.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('issuerLogo');
    // `programLogo` is the circular logo on the reference pass. It must still be
    // there, on the media host: this is a removal, not a swap.
    expect(payload.programLogo).toEqual({ sourceUri: { uri: BRAND_URL } });
  });

  it('takes the program name from loyalty_programs, not a generated one', async () => {
    const store = fakeStore({ programName: 'Tarjeta de fidelidad' });
    const client = fakeClient();

    await install(store, client);

    expect(client.insertClass).toHaveBeenCalledWith(
      expect.objectContaining({ programName: 'Tarjeta de fidelidad' }),
    );
  });

  it('refuses a promo copy Google would ellipsise, before calling Google', async () => {
    // The failure has to land before `insertClass`. A limit Google only
    // ellipsises produces a 200 and a comensal reading "Diez sellos, un burg…".
    const store = fakeStore({ promoCopy: 'x'.repeat(501) });
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(outcome).toMatchObject({ kind: 'failed', code: 'class_payload_invalid' });
    expect(client.insertClass).not.toHaveBeenCalled();
    expect(store.insertProgram).not.toHaveBeenCalled();
  });
});

/**
 * Does this customer-web route exist as a page?
 *
 * Reads the filesystem rather than trusting the list beside it. A route that
 * was renamed or deleted makes the link a 404 in the comensal's hand, and
 * nothing else in this repository would notice — the class inserts fine, the
 * pass renders, and the link is simply dead.
 */
function customerWebRouteExists(pathname: string): boolean {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  const directory = segments.reduce((from, segment) => join(from, segment), CUSTOMER_WEB_APP);
  return existsSync(join(directory, 'page.tsx'));
}

/**
 * Does the gateway register the route `/p/{slug}` is built from?
 *
 * The same discipline as `customerWebRouteExists`, applied to the field Google
 * rejects a class over. The gateway is a Hono worker rather than a Next.js app,
 * so there is no directory to walk: the route is a registration in
 * `apps/gateway/src/index.ts`, and that is what is read here.
 *
 * Without this, renaming `/p/*` in the gateway would leave every class pointing
 * at a 404 and every unit test in this file green — the class inserts fine, the
 * pass renders, and the failure shows up only in Google's review, weeks later.
 */
function gatewayServesMerchantPageRoute(): boolean {
  const source = readFileSync(join(GATEWAY_INDEX), 'utf8');
  // The registration, and the fact that it is mounted outside `/v1/*` — the
  // second half matters because under that prefix the route would require a JWT
  // and a reviewer's request carries none.
  return /app\.get\(\s*['"]\/p\/\*['"]/.test(source) && !/app\.get\(\s*['"]\/v1\/p\//.test(source);
}

// ============================================================================
// The callback URL
//
// This is the one field on a class that can be silently wrong. A wrong logo
// is an empty logo, a wrong homepage is a class Google rejects at review — both
// announce themselves. A wrong `callbackOptions.url` means Google never reports
// that a customer saved or deleted their pass, and the pass state keeps whatever
// the last reconcile inferred, with nothing anywhere logging an error. So the
// URL is pinned here rather than trusted to a default.
// ============================================================================

describe('provisionClass: the callback URL Google is given', () => {
  it('sends the real endpoint on the configured origin', async () => {
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);

    const payload = client.insertClass.mock.calls[0]![0] as { callbackOptions?: { url: string } };
    expect(payload.callbackOptions).toEqual({ url: CALLBACK_URL });
  });

  it('is the same URL for every tenant, because the class id identifies the tenant', async () => {
    // A per-tenant callback path would turn one public route into a routing
    // table keyed on a value from a request body, which is the cross-tenant
    // hazard the handler works to avoid. The callback carries its own `classId`,
    // so a single endpoint is enough — and this pins that it is one.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client);
    const payload = client.insertClass.mock.calls[0]![0] as { callbackOptions?: { url: string } };

    expect(payload.callbackOptions?.url).not.toContain(SLUG);
    expect(payload.callbackOptions?.url).not.toContain(TENANT);
  });

  it('defaults to the production gateway, not a test host, when the var is absent', async () => {
    // The default is load-bearing. `callbackOptions.url` is written at insert and
    // a Google class cannot be recreated under the same id, so a class created
    // against a staging or local host reports to that host for its whole life —
    // silently, because a missing callback looks exactly like a customer who has
    // not opened the app.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client, { WALLET_CALLBACK_BASE_URL: undefined });

    const payload = client.insertClass.mock.calls[0]![0] as { callbackOptions?: { url: string } };
    const url = payload.callbackOptions?.url ?? '';

    expect(url.startsWith('https://')).toBe(true);
    expect(url).not.toMatch(/localhost|127\.0\.0\.1|example\.(com|test)|invalid-host/);
    // And it is the gateway that actually serves the route, not a host that
    // merely looks like production.
    expect(new URL(url).origin).toBe('https://media.juancode.dev');
  });

  it('reads the origin from its own var, so it cannot be swapped with the homepage host', async () => {
    // Same shape as the transposed-parsers test above, applied to the field that
    // fails silently. A shared implementation or a transposed var would send
    // callbacks to the media host and nothing would say so.
    const store = fakeStore();
    const client = fakeClient();

    await install(store, client, {
      WALLET_WEB_BASE_URL: 'https://web.invalid-host.test',
      WALLET_CALLBACK_BASE_URL: 'https://callback.invalid-host.test',
    });

    const payload = client.insertClass.mock.calls[0]![0] as {
      callbackOptions?: { url: string };
      homepageUri: { uri: string };
    };

    expect(new URL(payload.callbackOptions?.url ?? '').origin).toBe(
      'https://callback.invalid-host.test',
    );
    expect(new URL(payload.homepageUri.uri).origin).toBe('https://web.invalid-host.test');
  });

  it('is a path the gateway actually exempts from auth', async () => {
    // The two sides of this feature name the same string, and a typo on either
    // one produces a 403 on every real delivery with a message about missing
    // headers — indistinguishable, from the outside, from a broken signature.
    // So the gateway's declaration and the URL Google is given are asserted to
    // agree. `gatewayDeclaredCallbackPath` reads the gateway's own source, since
    // this package does not depend on it.
    const configured = new URL(CALLBACK_URL).pathname;

    expect(gatewayDeclaredCallbackPath()).toBe(configured);
    // Mounted under `/v1/*`, which is where the auth middlewares run — so being
    // under it is the reason the exemption is load-bearing, not a detail.
    expect(configured.startsWith('/v1/')).toBe(true);
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

  it('reports a tenant with no slug, because there is no public page to point at', async () => {
    // `tenants.slug` is `notNull`, so an empty string is a value a writer can
    // produce rather than an impossible state. It builds `/p/`, which is a 404 on
    // the one field Google rejects a class over — silently, long after this run
    // returned `created`, and only visible in a review weeks later.
    const store = fakeStore({ branding: brandingRow({ slug: '' }) });
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(outcome).toMatchObject({ kind: 'failed', code: 'tenant_slug_missing' });
    expect(client.insertClass).not.toHaveBeenCalled();
    expect(store.insertProgram).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only slug as no slug', async () => {
    // The same reason `findProgramName` treats a blank name as absent: an empty
    // `homepageUri` path is a valid-looking URL to nothing.
    const store = fakeStore({ branding: brandingRow({ slug: '   ' }) });
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(outcome).toMatchObject({ kind: 'failed', code: 'tenant_slug_missing' });
    expect(client.insertClass).not.toHaveBeenCalled();
  });

  it(`sends the tenant's real slug, encoded, and never the name folded into one`, async () => {
    // `homepageUri` is `{webBaseUrl}/p/{slug}`, and that page is a real route in
    // the gateway that resolves `tenants.slug`. Two businesses named "Café
    // Central" do not both end up at `cafe-central` — the unique index settles it
    // — so a slug recomputed from the name at provision time is a guess, and a
    // guess here is a 404 on the field Google reviews.
    const store = fakeStore({ branding: brandingRow({ name: 'Café Central', slug: 'cafe-central-2' }) });
    const client = fakeClient();

    await install(store, client);

    const payload = client.insertClass.mock.calls[0]![0] as { homepageUri: { uri: string } };
    expect(payload.homepageUri.uri).toBe(`${WEB_BASE_URL}/p/cafe-central-2`);
    expect(payload.homepageUri.uri).not.toContain('Caf');
  });

  it('percent-encodes a slug rather than splicing it in raw', async () => {
    // Defence in depth: the gateway'"'"'s guard refuses anything but `[a-z0-9-]`, so
    // this cannot produce a working page either way. But a raw splice would put a
    // URL in Google'"'"'s database that differs from the one the route serves, and
    // the mismatch is only visible at review.
    const store = fakeStore({ branding: brandingRow({ slug: 'café central' }) });
    const client = fakeClient();

    await install(store, client);

    const payload = client.insertClass.mock.calls[0]![0] as { homepageUri: { uri: string } };
    expect(payload.homepageUri.uri).toBe(`${WEB_BASE_URL}/p/caf%C3%A9%20central`);
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

// ============================================================================
// Whether trying again is worth anything
//
// The caller of this is the signup path, which retries under `waitUntil`. It
// cannot see a status code or an error body — it receives this outcome over a
// service binding and nothing else — so the judgement about a retry belongs here,
// next to the error, where the evidence is.
//
// These assertions are about the flag rather than about a retry loop on purpose:
// the loop lives in another worker and is tested there. What has to be pinned
// here is the fact this reports, because a `false` here is what stops three
// Google writes being spent on an answer that cannot change.
// ============================================================================

describe('provisionClass: whether a failure is worth another attempt', () => {
  type Outcome = Awaited<ReturnType<typeof install>>;

  /** The failed outcome, or a throw naming what came back instead. */
  function asFailed(outcome: Outcome): { code: string; message: string; retryable?: boolean } {
    if (outcome.kind !== 'failed') throw new Error(`expected a failed outcome, got ${outcome.kind}`);
    return outcome;
  }

  it('says a malformed payload will not be fixed by asking again', async () => {
    // The case the flag exists for. Google read the request and rejected the
    // request; a retry sends the same bytes and is rejected the same way, so the
    // only thing three attempts buy is three `insertClass` calls.
    const store = fakeStore();
    const client = fakeClient({ failWith: apiError(400, 'invalidField') });

    expect(asFailed(await install(store, client)).retryable).toBe(false);
  });

  it('says a 4xx from Google is permanent, whatever the reason it names', async () => {
    // The rule is about the status, not about the code: `invalidField` is the
    // documented example, but an id Google dislikes or a class in the wrong state
    // is the same shape of answer — a statement about our request.
    for (const code of ['invalidField', 'wallet_class.invalidId', 'notFound']) {
      const store = fakeStore();
      const client = fakeClient({ failWith: apiError(404, code) });

      expect(asFailed(await install(store, client)).retryable).toBe(false);
    }
  });

  it('says a 5xx is worth another attempt', async () => {
    const store = fakeStore();
    const client = fakeClient({ failWith: apiError(503, 'UNAVAILABLE') });

    // A statement about Google, not about us. This is the failure the signup
    // retry exists for.
    expect(asFailed(await install(store, client)).retryable).toBe(true);
  });

  it('says a throttled request is worth another attempt', async () => {
    // 429 is the one 4xx that is not about the request. Collapsing it with the
    // rest of the 4xx range would make a rate limit permanently un-retryable,
    // which is backwards: it is the clearest signal there is to wait.
    const store = fakeStore();
    const client = fakeClient({ failWith: apiError(429, 'rateLimitExceeded') });

    expect(asFailed(await install(store, client)).retryable).toBe(true);
  });

  it('says a failure to reach Google at all is worth another attempt', async () => {
    // No status, no body: the token exchange failed, or the socket did. Nothing
    // has told us anything about the request, so nothing forbids trying again.
    const store = fakeStore();
    const client = fakeClient({ failWith: new Error('Could not obtain a Google Wallet access token') });

    expect(asFailed(await install(store, client)).retryable).toBe(true);
  });

  it('says a row that could not be written is worth another attempt', async () => {
    // The orphan case, and the clearest retry in the whole module: the class is at
    // Google, only the record is missing, and the next attempt writes it.
    const store = fakeStore({ insertFails: true });
    const client = fakeClient();

    expect(asFailed(await install(store, client)).retryable).toBe(true);
  });

  const permanentData: Array<[string, ProvisionFailureCode, () => FakeStore]> = [
    ['a tenant with no row', 'tenant_not_found', () => fakeStore({ branding: null })],
    ['a tenant with no loyalty program', 'loyalty_program_not_found', () => fakeStore({ programName: null })],
    ['a payload it refuses to build', 'class_payload_invalid', () => fakeStore({ branding: brandingRow({ name: '   ' }) })],
  ];

  for (const [what, code, build] of permanentData) {
    it(`says ${what} is not fixed by waiting`, async () => {
      // Data-shaped failures, all three. Waiting changes none of them: the tenant
      // row, the loyalty program and a blank name are facts about this business,
      // and only somebody editing them can change the answer.
      const failed = asFailed(await install(build(), fakeClient()));

      expect(failed.code).toBe(code);
      expect(failed.retryable).toBe(false);
    });
  }

  it('reports no flag at all on a success, so a success cannot be read as a retryable failure', async () => {
    const store = fakeStore();
    const client = fakeClient();

    const outcome = await install(store, client);

    expect(outcome).not.toHaveProperty('retryable');
  });
});
