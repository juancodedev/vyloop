import { beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'test-jwt-secret-key-for-customer-login-only';

const CAFE_A = { id: 'tenant-a', slug: 'cafe-central', name: 'Café Central' };
const CAFE_B = { id: 'tenant-b', slug: 'cafe-prueba-0117', name: 'Café Prueba' };

const AT_A = {
  id: 'cust-a',
  globalId: 'aaaa-1111',
  phone: '+56998307778',
  fullName: 'Juan',
  businessId: CAFE_A.id,
  deletedAt: null,
};
const AT_B = { ...AT_A, id: 'cust-b', globalId: 'bbbb-2222', businessId: CAFE_B.id };

/**
 * What each lookup yields.
 *
 * Staged per test rather than filtered, because which row a lookup returns depends on
 * the predicate, and reproducing Drizzle's `where(and(eq(...)))` inside a stub would
 * be testing the stub. What is asserted here is the route's *decisions* — which
 * lookups it makes, and what it does when one comes back empty.
 */
let tenantLookup: (typeof CAFE_A)[] = [];
let customerLookup: (typeof AT_A)[] = [];
/** Every `from()` call, in order, so a test can prove a lookup never happened. */
let queries: string[] = [];

vi.mock('@vyloop/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vyloop/db')>();

  return {
    ...actual,
    createDb: () => ({
      select: () => ({
        from: (table: Record<string, unknown>) => {
          const isTenants = 'slug' in table;
          queries.push(isTenants ? 'tenants' : 'customers');
          const rows = isTenants ? tenantLookup : customerLookup;

          return { where: () => ({ limit: () => Promise.resolve(rows.slice(0, 1)) }) };
        },
      }),
    }),
    schema: {
      ...actual.schema,
      tenants: { id: 'id', slug: 'slug', name: 'name' },
      customers: {
        id: 'id',
        globalId: 'global_id',
        phone: 'phone',
        fullName: 'full_name',
        businessId: 'business_id',
        deletedAt: 'deleted_at',
      },
    },
  };
});

// The module default is the Workers export shape, so `fetch` is called directly
// rather than through a Hono test helper.
const { default: worker } = await import('./index');

function login(body: Record<string, unknown>) {
  return worker.fetch(
    new Request('http://identity.internal/v1/auth/customer/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { JWT_SECRET: SECRET, DATABASE_URL: 'postgres://test' } as never,
  );
}

beforeEach(() => {
  tenantLookup = [CAFE_A];
  customerLookup = [AT_A];
  queries = [];
});

describe('customer login across businesses', () => {
  /**
   * The case that had no coverage at all, and that decided which café a person landed
   * in.
   *
   * `customers` holds one row per (business, phone), so "log in this phone" has no
   * answer on its own. The route used to ask anyway with `limit 1` and no ordering —
   * whichever row the database yielded first, which is not guaranteed to be stable
   * between requests. Refused before any database work, because looking is the thing
   * that picked the tenant.
   */
  it('refuses a login with no business, rather than picking one', async () => {
    const res = await login({ phone: AT_A.phone });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_BUSINESS_REQUIRED');
    expect(queries).toEqual([]);
  });

  /**
   * Tenant isolation, failing silently.
   *
   * The tenant lookup was conditional — it refined the customer query only when the
   * business was found — so a slug that did not exist left the customer query
   * untouched and issued a valid token for whatever tenant the unfiltered phone
   * search reached first. No error, and the caller believed it was in a business it
   * had never named. That token renders a café's name and writes its QR against a
   * customer id from somewhere else, and the cashier scans it.
   *
   * The rows the fallback would have reached are staged and in scope, so this test
   * fails if the refusal ever becomes a fallback again.
   */
  it('refuses an unknown business instead of falling back to any tenant', async () => {
    tenantLookup = [];
    customerLookup = [AT_A, AT_B];

    const res = await login({ phone: AT_A.phone, businessSlug: 'no-existe' });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_BUSINESS_UNKNOWN');
    expect(queries).toEqual(['tenants']);
  });

  it('scopes the token to the business that was asked for', async () => {
    tenantLookup = [CAFE_B];
    customerLookup = [AT_B];

    const res = await login({ phone: AT_B.phone, businessSlug: CAFE_B.slug });

    expect(res.status).toBe(200);
    expect(queries).toEqual(['tenants', 'customers']);

    const body = (await res.json()) as { customer: { globalId: string } };
    expect(body.customer.globalId).toBe(AT_B.globalId);
  });

  /** A business the customer never joined is a refusal, not another tenant's record. */
  it('answers not-registered when the phone is not in that business', async () => {
    customerLookup = [];

    const res = await login({ phone: '+56955550000', businessSlug: CAFE_B.slug });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_TOKEN_INVALID');
  });
});