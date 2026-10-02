// @vitest-environment node

/**
 * `/p/{slug}` is a public, unauthenticated page that interpolates two
 * merchant-authored strings — `tenants.name` and `loyalty_programs.promo_copy`
 * — straight into HTML. It is the URL Google opens while reviewing a loyalty
 * class, so it must render in the bytes the reviewer receives.
 *
 * Everything asserted here is a property of that one sentence: untrusted text
 * reaches a public route, and a crawler has to be able to read the result.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MERCHANT_PAGE_TTL_SECONDS,
  escapeHtml,
  merchantPageRoute,
  merchantSlugFrom,
  renderMerchantPage,
} from './merchant-page';
import type { MerchantPageData, MerchantPageReader } from './merchant-page';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';

function merchant(overrides: Partial<MerchantPageData> = {}): MerchantPageData {
  return {
    tenantId: TENANT,
    name: 'Café Central',
    slug: 'cafe-central',
    programName: 'Programa de Lealtad Café Central',
    promoCopy: '¡Cada 10 cafés, uno gratis!',
    pointsCurrency: 'puntos',
    earnRate: '1.0',
    minRedeemPoints: 100,
    ...overrides,
  };
}

/** A reader that records every slug it was asked about, so "did not reach the DB" is assertable. */
function readerReturning(merchant: MerchantPageData | null) {
  const findBySlug = vi.fn(async () => merchant);
  return { findBySlug, reader: { findBySlug } satisfies MerchantPageReader };
}

const env = { DATABASE_URL: 'postgres://mock' };

/**
 * Every element name that appears as a *tag* in the document.
 *
 * This is the assertion that actually catches an XSS, and it is why it is not a
 * substring search. A merchant's promo copy legitimately contains the characters
 * `onerror=` once escaped, so `expect(html).not.toContain('onerror')` fails
 * against a page that is perfectly safe — and an assertion that fails on correct
 * code is an assertion that gets deleted. Instead: the set of tags in the output
 * must be exactly the set the renderer writes. Escaped text cannot add a tag, so
 * this is a complete statement about injected markup.
 */
function tagNamesIn(html: string): Set<string> {
  const names = new Set<string>();
  for (const match of html.matchAll(/<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/g)) {
    names.add(match[1]!.toLowerCase());
  }
  return names;
}

/**
 * The elements `renderMerchantPage` is allowed to emit.
 *
 * `script` is absent by construction, and that is the point: it is not on this
 * list because the page has none, so one appearing is a failure.
 */
const EXPECTED_TAGS = [
  'html',
  'head',
  'meta',
  'title',
  'body',
  'main',
  'img',
  'h1',
  'h2',
  'p',
  'strong',
  'blockquote',
  'section',
];

async function serve(
  path: string,
  reader: MerchantPageReader,
): Promise<Response> {
  const route = merchantPageRoute(reader);
  const c = {
    env,
    req: { url: `https://media.juancode.dev${path}`, param: () => undefined },
    // `c.html` is the only responder the route uses.
    html: (body: string, status = 200, headers: Record<string, string> = {}) =>
      new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } }),
  };
  return (route as unknown as (c: unknown) => Promise<Response>)(c);
}

// ---------------------------------------------------------------------------
// The escape function itself
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes every character that can change the meaning of the markup', () => {
    // The five, not "the ones that seemed important". A sixth — a backtick, a
    // space, `javascript:` — is only dangerous in an attribute this page does
    // not have, and a guard that grows past the markup it is escaping starts
    // encoding text a reader should see.
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes the ampersand first, so an escape is never itself escaped', () => {
    // `<` becomes `&lt;`. Escaping in the other order would turn that into
    // `&amp;lt;` and the page would show the reader `<script>` as literal text
    // where a `<` was.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary merchant text untouched', () => {
    expect(escapeHtml('Café Central')).toBe('Café Central');
    expect(escapeHtml('¡Cada 10 cafés, uno gratis!')).toBe('¡Cada 10 cafés, uno gratis!');
  });
});

// ---------------------------------------------------------------------------
// The slug guard, before any database access
// ---------------------------------------------------------------------------

describe('merchantSlugFrom', () => {
  it('reads a slug out of the path', () => {
    expect(merchantSlugFrom('/p/cafe-central')).toBe('cafe-central');
  });

  it('refuses a path that climbs out with literal dots', () => {
    // The literal form is normalised away by `new URL().pathname` before this
    // ever sees it, so it proves nothing about the guards below. Stated anyway,
    // because it is the shape an attacker actually sends and it must not depend
    // on which layer normalises it.
    expect(new URL('https://x/p/../secret').pathname).toBe('/secret');
    expect(merchantSlugFrom('/p/../secret')).toBeNull();
  });

  it('refuses an encoded traversal, which is the one that survives the URL parser', () => {
    // Percent-encoded dots and slashes are NOT decoded by the URL parser: they
    // reach `pathname` intact, and only `decodeURIComponent` here would turn
    // them back into a traversal. Same bug class `brandKeyFor` was written for.
    expect(merchantSlugFrom('/p/%2e%2e%2fsecret')).toBeNull();
    expect(merchantSlugFrom('/p/%2E%2E%2Fsecret')).toBeNull();
    expect(merchantSlugFrom('/p/%2e%2e%2f%2e%2e%2fetc%2fpasswd')).toBeNull();
  });

  it('refuses a slug carrying a separator, a query or a fragment', () => {
    expect(merchantSlugFrom('/p/central/secreto')).toBeNull();
    expect(merchantSlugFrom('/p/central%2Fsecreto')).toBeNull();
    expect(merchantSlugFrom("/p/central' OR 1=1--")).toBeNull();
    expect(merchantSlugFrom('/p/central?admin=1')).toBeNull();
    expect(merchantSlugFrom('/p/central#x')).toBeNull();
    expect(merchantSlugFrom('/p/.env')).toBeNull();
    expect(merchantSlugFrom('/p/central.json')).toBeNull();
  });

  it('decodes a percent-encoded slug, because a legal encoding is still that merchant', () => {
    // The load-bearing half of the decode, and the reason it is not merely
    // defensive. `%2D` is a percent-encoded hyphen: a legal encoding of a slug
    // this platform owns, so a client that encodes the path must still land on
    // that merchant's page. Without the decode the segment is refused, because
    // `SLUG_PATTERN` excludes `%` — a 404 on a page that exists, for a URL that
    // is correct.
    //
    // The mirror image is the traversal case above: the decode is also what turns
    // `%2e%2e%2f` back into `../`, which is exactly why the shape test has to
    // run on the decoded value and not before it.
    expect(merchantSlugFrom('/p/cafe%2Dcentral')).toBe('cafe-central');
  });

  it('refuses an empty slug and anything not under the prefix', () => {
    expect(merchantSlugFrom('/p/')).toBeNull();
    expect(merchantSlugFrom('/p')).toBeNull();
    expect(merchantSlugFrom('/v1/p/cafe-central')).toBeNull();
    expect(merchantSlugFrom('/brand/cafe-central.jpg')).toBeNull();
  });

  it('refuses malformed percent-encoding instead of throwing', () => {
    // `decodeURIComponent('%zz')` throws a `URIError`. A thrown guard on a
    // public route is a 500 for a request that should be a 404, and it hands a
    // crawler an error page where a page is what Google is looking for.
    expect(merchantSlugFrom('/p/%zz')).toBeNull();
    expect(merchantSlugFrom('/p/%')).toBeNull();
  });

  it('accepts only the shape slugify emits, so a slug cannot arrive in a shape the writer cannot produce', () => {
    expect(merchantSlugFrom('/p/cafe-central')).toBe('cafe-central');
    expect(merchantSlugFrom('/p/123')).toBe('123');
    expect(merchantSlugFrom('/p/CAFÉ')).toBeNull();
    expect(merchantSlugFrom('/p/-leading')).toBeNull();
    expect(merchantSlugFrom('/p/trailing-')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The rendered page
// ---------------------------------------------------------------------------

describe('renderMerchantPage', () => {
  it('puts the merchant name in the served bytes, not behind a script', () => {
    // The whole reason this page is in the gateway and not in the dashboard's
    // static export: a reviewer's HTTP client sees 18 characters of text there.
    const html = renderMerchantPage(merchant());

    expect(html).toContain('Café Central');
    expect(html).toContain('<title>');
  });

  it('carries no script at all, even when a merchant writes one', () => {
    // Not "no inline script". None. The page is read by a crawler and by a
    // phone on a bad connection; anything executable here is weight with no
    // reader.
    //
    // The event-handler assertion is stated the narrow way on purpose. The
    // string `onerror=` *does* appear below, as inert escaped text inside a
    // blockquote — which is the point: the payload survives as readable text and
    // not as an attribute. What must not exist is an `on…=` that a parser would
    // read as an attribute, so the tag-stripped document is what gets checked.
    const html = renderMerchantPage(
      merchant({ name: '<script>alert(1)</script>', promoCopy: '<img onerror=alert(1)>' }),
    );

    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<\/script/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(tagNamesIn(html)).toEqual(new Set(EXPECTED_TAGS));
  });

  it('escapes a merchant name carrying markup', () => {
    // The merchant writes their own name at signup. This route renders it on an
    // unauthenticated URL, so an unescaped name here is a stored XSS on a route
    // anyone can load.
    const html = renderMerchantPage(merchant({ name: '<script>alert(1)</script>' }));

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('escapes promo copy carrying markup, attributes and both quote styles', () => {
    const promo = `<img src=x onerror="alert('1')">`;
    const html = renderMerchantPage(merchant({ promoCopy: promo }));

    // The page has exactly one image and it is the platform's own logo, so the
    // attacker's tag must not survive as a tag. Asserting on the whole document
    // would be wrong here — `onerror` *does* appear, as escaped text, which is
    // the payload being shown to the reader rather than run.
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;');
  });

  it('escapes the program name, which is merchant-authored too', () => {
    const html = renderMerchantPage(
      merchant({ programName: '"><script>alert(1)</script>' }),
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('points the logo at the brand route the platform already serves', () => {
    // The tenant id, not the slug: `/brand/*` is keyed by tenant id, and a slug
    // key would 404 for every business that has not uploaded anything.
    const html = renderMerchantPage(merchant());

    expect(html).toContain(`/brand/${TENANT}.jpg`);
  });

  it('says how to earn and where to spend, from the program row', () => {
    const html = renderMerchantPage(
      merchant({ earnRate: '2.0', minRedeemPoints: 250, pointsCurrency: 'puntos' }),
    );

    expect(html).toContain('2');
    expect(html).toContain('250');
    expect(html).toContain('puntos');
  });

  it('omits the promo block entirely when the merchant wrote none', () => {
    // Omitted, never substituted — the same rule `findPromoCopy` follows and the
    // class builder follows. A default sentence here is a merchant's page
    // reading words nobody wrote.
    const html = renderMerchantPage(merchant({ promoCopy: null }));

    expect(html).toContain('Café Central');
    expect(html).not.toMatch(/promo/i);
  });

  it('says nothing invented about a program that has not been configured', () => {
    const html = renderMerchantPage(
      merchant({
        programName: null,
        promoCopy: null,
        pointsCurrency: null,
        earnRate: null,
        minRedeemPoints: null,
      }),
    );

    expect(html).toContain('Café Central');
    expect(html).not.toMatch(/undefined|null|NaN/);
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

describe('the merchant page route', () => {
  it('answers 200 with HTML for a merchant that exists', async () => {
    const { reader } = readerReturning(merchant());

    const res = await serve('/p/cafe-central', reader);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('Café Central');
  });

  it('requires no authentication, because it is the page a reviewer opens', async () => {
    // No Authorization header, no X-Business-ID, nothing. Asserted through the
    // route because the whole reason it lives here rather than behind the
    // gateway's middleware chain is that the chain would refuse it.
    const { reader } = readerReturning(merchant());

    const res = await serve('/p/cafe-central', reader);

    expect(res.status).toBe(200);
  });

  it('404s a slug no merchant has', async () => {
    const { reader } = readerReturning(null);

    const res = await serve('/p/nobody-here', reader);

    expect(res.status).toBe(404);
  });

  it('404s a malformed slug rather than 500ing, and never reaches the database', async () => {
    // Both halves matter. A 500 where a 404 belongs is what a crawler sees
    // while reviewing a class; and a guard that only ran *after* the lookup
    // would have handed a traversal string to a query.
    const { findBySlug, reader } = readerReturning(merchant());

    const res = await serve('/p/%2e%2e%2fsecret', reader);

    expect(res.status).toBe(404);
    expect(findBySlug).not.toHaveBeenCalled();
  });

  it('404s every traversal shape without reaching the database', async () => {
    const shapes = [
      '/p/../secret',
      '/p/%2e%2e%2fsecret',
      '/p/%2E%2E%2Fsecret',
      '/p/central/secreto',
      '/p/%2fetc%2fpasswd',
      '/p/',
      '/p',
    ];

    for (const path of shapes) {
      const { findBySlug, reader } = readerReturning(merchant());

      const res = await serve(path, reader);

      expect(res.status, path).toBe(404);
      expect(findBySlug, path).not.toHaveBeenCalled();
    }
  });

  it('asks the database for the slug the request named, and nothing else', async () => {
    const { findBySlug, reader } = readerReturning(merchant());

    await serve('/p/cafe-central', reader);

    expect(findBySlug).toHaveBeenCalledTimes(1);
    expect(findBySlug).toHaveBeenCalledWith('cafe-central');
  });

  it('caches publicly, because the page is identical for every reader', async () => {
    const { reader } = readerReturning(merchant());

    const res = await serve('/p/cafe-central', reader);

    const cacheControl = res.headers.get('Cache-Control') ?? '';
    expect(cacheControl).toContain('public');
    expect(cacheControl).toMatch(/max-age=\d+/);
  });

  it('declares a TTL short enough that a promo edit converges', async () => {
    // Long enough that Google's crawler and a phone on a bad connection do not
    // each re-read the row; short enough that a merchant who edits their promo
    // copy sees it within the hour rather than tomorrow. Pinned so "we set a
    // reasonable TTL" cannot quietly become "a year".
    expect(MERCHANT_PAGE_TTL_SECONDS).toBeGreaterThan(0);
    expect(MERCHANT_PAGE_TTL_SECONDS).toBeLessThanOrEqual(3600);
  });

  it('sends no credentials of its own on the response', async () => {
    // `public` caching plus a `Set-Cookie` would let one edge store a response
    // another reader receives. Nothing here is per-reader, so nothing may make
    // it per-reader.
    const { reader } = readerReturning(merchant());

    const res = await serve('/p/cafe-central', reader);

    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(res.headers.get('Vary')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The store seam
//
// The route is exercised against a reader, not a database, so these assert the
// shape the route depends on rather than the SQL that produces it.
// ---------------------------------------------------------------------------

describe('the merchant page reader contract', () => {
  // Typed as the contract rather than as `vi.fn`, so the fixture below has to
  // satisfy the same signature the route calls with.
  let findBySlug: (slug: string) => Promise<MerchantPageData | null>;

  beforeEach(() => {
    findBySlug = vi.fn(async (_slug: string) => merchant());
  });

  it('resolves a slug to the merchant and its program, in one call', async () => {
    const reader: MerchantPageReader = { findBySlug };

    const found = await reader.findBySlug('cafe-central');

    expect(found?.tenantId).toBe(TENANT);
    expect(found?.promoCopy).toBe('¡Cada 10 cafés, uno gratis!');
  });

  it('answers null for a slug with no tenant behind it', async () => {
    const reader: MerchantPageReader = { findBySlug: vi.fn(async () => null) };

    expect(await reader.findBySlug('nobody')).toBeNull();
  });
});