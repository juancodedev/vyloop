// The `vi.mock` factory is hoisted above every import, which is why the modules
// under test are imported after it.

vi.mock('./merchant-store', async () => {
  const { merchantSlugFrom } = await import('./merchant-page');

  return {
    // The seam is the database. `findBySlug` records the slug it was handed so
    // these tests can assert that a malformed slug never got one — the claim a
    // unit test of the route alone cannot make, because the route receives a
    // reader and knows nothing about whether it was called.
    createMerchantPageReader: vi.fn(() => ({
      findBySlug: vi.fn(async (slug: string) => {
        recorded.push(slug);
        if (merchantSlugFrom(`/p/${slug}`) === null) return null;
        return TENANT_ROWS[slug] ?? null;
      }),
    })),
  };
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MerchantPageData } from './merchant-page';
import { createMerchantPageReader } from './merchant-store';

const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const OTHER = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/** The slugs this fake database knows, with a hostile merchant among them. */
const TENANT_ROWS: Record<string, MerchantPageData> = {
  'cafe-central': {
    tenantId: TENANT,
    name: 'Café Central',
    slug: 'cafe-central',
    programName: 'Programa de Lealtad Café Central',
    promoCopy: '¡Cada 10 cafés, uno gratis!',
    pointsCurrency: 'puntos',
    earnRate: '1.0',
    minRedeemPoints: 100,
  },
  // The two merchant-authored strings, carrying markup. A page that rendered
  // either unescaped would be a stored XSS on a URL anyone can load.
  'hostel': {
    tenantId: OTHER,
    name: '<script>alert(1)</script>',
    slug: 'hostel',
    programName: 'Programa "<b>VIP</b>"',
    promoCopy: `<img src=x onerror="alert('1')">`,
    pointsCurrency: 'puntos',
    earnRate: '1.0',
    minRedeemPoints: 50,
  },
};

/** Every slug the reader was asked for, in order. */
const recorded: string[] = [];

function mockEnv() {
  return {
    JWT_SECRET: 'test-secret',
    DATABASE_URL: 'postgres://mock',
    RATE_LIMITER: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
  };
}

let app: typeof import('./index').default;

beforeEach(async () => {
  recorded.length = 0;
  vi.clearAllMocks();
  app = (await import('./index')).default;
});

// ---------------------------------------------------------------------------
// The route, through the gateway's real middleware chain
// ---------------------------------------------------------------------------

describe('GET /p/{slug} through the gateway', () => {
  it('answers a merchant page with no authentication headers at all', async () => {
    // No `Authorization`, no `X-Business-ID`. Not "no valid" — absent. This is
    // the assertion that pins the route's exemption: the auth middleware is
    // registered with `app.use('/v1/*')`, and this path is not under it, so
    // moving the route under `/v1/*` would turn this into a 401.
    const res = await app.fetch(new Request('https://api.test/p/cafe-central'), mockEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/);
  });

  it('puts the merchant name in the served bytes', async () => {
    // The reason this page is in the gateway at all. The dashboard renders on
    // the client, so its HTML is 8,610 bytes of which 18 are text; Google's
    // reviewer would read a `<title>` and nothing else.
    const res = await app.fetch(new Request('https://api.test/p/cafe-central'), mockEnv());

    const body = await res.text();
    expect(body).toContain('Café Central');
    expect(body).toContain('<title>');
  });

  it('serves no script, and no script tag a reviewer would refuse the class over', async () => {
    const res = await app.fetch(new Request('https://api.test/p/cafe-central'), mockEnv());

    const body = await res.text();
    expect(body).not.toMatch(/<script/i);
  });

  it('escapes a merchant name carrying markup', async () => {
    const res = await app.fetch(new Request('https://api.test/p/hostel'), mockEnv());

    const body = await res.text();
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).not.toMatch(/<script/i);
  });

  it('escapes promo copy carrying an event-handler attribute', async () => {
    const res = await app.fetch(new Request('https://api.test/p/hostel'), mockEnv());

    const body = await res.text();
    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;');
  });

  it('points the logo at the brand route, keyed by tenant id', async () => {
    const res = await app.fetch(new Request('https://api.test/p/cafe-central'), mockEnv());

    expect(await res.text()).toContain(`/brand/${TENANT}.jpg`);
  });

  it('404s a slug no merchant has', async () => {
    const res = await app.fetch(new Request('https://api.test/p/nadie'), mockEnv());

    expect(res.status).toBe(404);
  });

  it('404s a malformed slug rather than 500ing, and never reads the database', async () => {
    // Both halves are the requirement. A 500 where a 404 belongs is what a
    // crawler sees mid-review; and a guard that ran after the lookup would
    // already have handed a traversal string to a query.
    for (const path of [
      '/p/%2e%2e%2fsecret',
      '/p/%2E%2E%2Fsecret',
      '/p/central%2Fsecreto',
      '/p/%zz',
      '/p/',
      '/p',
    ]) {
      const res = await app.fetch(new Request(`https://api.test${path}`), mockEnv());

      expect(res.status, path).toBe(404);
    }

    expect(recorded).toEqual([]);
  });

  it('404s a literal traversal without reading the database', async () => {
    // `new Request` normalises `/p/../x` to `/x` before it leaves this function,
    // so the request never matches `/p/*` at all. Stated separately because it
    // is the shape an attacker actually sends, and "it 404s" must not depend on
    // which layer normalised it.
    const res = await app.fetch(new Request('https://api.test/p/../secret'), mockEnv());

    expect(res.status).toBe(404);
    expect(recorded).toEqual([]);
  });

  it('asks the database only for the slug the request named', async () => {
    await app.fetch(new Request('https://api.test/p/cafe-central'), mockEnv());

    expect(recorded).toEqual(['cafe-central']);
  });

  it('builds a fresh reader per request, rather than capturing a pool at module scope', async () => {
    // An isolate is reused across requests, so a `createDb` call hoisted to
    // module scope would share one pool across every request it serves — which
    // is not what happens in production and is not what a test can observe.
    await app.fetch(new Request('https://api.test/p/cafe-central'), mockEnv());
    await app.fetch(new Request('https://api.test/p/otro'), mockEnv());

    expect(createMerchantPageReader).toHaveBeenCalledTimes(2);
  });

  it('answers every public merchant page without a token, and the protected surface still refuses one', async () => {
    // The counterpart, so the exemption cannot be widened to `/p*` *and* the
    // `/v1/*` chain loosened to match: the page is open and `/v1/customers` is
    // not.
    const page = await app.fetch(new Request('https://api.test/p/cafe-central'), mockEnv());
    const protectedRoute = await app.fetch(
      new Request('https://api.test/v1/customers'),
      mockEnv(),
    );

    expect(page.status).toBe(200);
    expect(protectedRoute.status).toBe(401);
  });
});