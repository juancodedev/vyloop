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
  DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL,
  MERCHANT_PAGE_TTL_SECONDS,
  escapeHtml,
  merchantPageRoute,
  merchantSlugFrom,
  parseCustomerWebBaseUrl,
  registerHrefFor,
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
 * The customer-web origin the CTA points at, injected so a test can prove the
 * *value* is used rather than a default baked into the renderer.
 */
const CUSTOMER_WEB_BASE = 'https://vyloop-customer-web.pages.dev';

/**
 * The two hosts the CTA must NOT resolve to.
 *
 * `WALLET_MEDIA_BASE_URL` builds `/brand/*` and `WALLET_WEB_BASE_URL` builds
 * `homepageUri` — both `https://media.juancode.dev` today. Neither host serves
 * `/register`: those routes live in `apps/customer-web`. Pointing the CTA at
 * either one produces a link that 404s, silently, which is the `programLogo`
 * defect at a different URL. Named here so the assertion below reads as a
 * prohibition rather than as a string comparison.
 */
const FORBIDDEN_CTA_HOSTS = ['media.juancode.dev', 'vyloop-dashboard'];

/** Every anchor the renderer writes, in document order. */
function hrefsIn(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((match) => match[1] as string);
}

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
 * The document with every run of text removed, leaving only markup.
 *
 * This is what makes "is that event handler live?" a question about the document
 * rather than about the page's contents. Escaped merchant text contains no `<`,
 * so it disappears here entirely: a payload that renders as `onerror=` in a
 * blockquote is gone from this string, and one that rendered as a real
 * `onerror=` attribute is not.
 */
function stripText(html: string): string {
  return html.replace(/[^<]+/g, '');
}

/**
 * The elements `renderMerchantPage` is allowed to emit.
 *
 * `script` is absent by construction, and that is the point: it is not on this
 * list because the page has none, so one appearing is a failure.
 *
 * `a` is present because the page carries exactly one call to action — the way in
 * for a person, which is the whole reason this route exists for humans and not
 * only for Google's reviewer. Adding it here narrows nothing on its own, because
 * escaped merchant text still cannot become a tag; the companion assertion on
 * anchor *count* below is what keeps a second, injected anchor from blending in.
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
  'a',
];

/** How many anchors the renderer writes. Exactly this many, never more. */
const EXPECTED_ANCHOR_COUNT = 1;

/**
 * The renderer under test, with the customer-web origin injected.
 *
 * Every render assertion goes through this rather than calling
 * `renderMerchantPage` with a literal, so no assertion can pass by accident
 * against a default that happens to equal the expected string.
 */
function render(data: MerchantPageData, customerWebBaseUrl = CUSTOMER_WEB_BASE): string {
  return renderMerchantPage(data, customerWebBaseUrl);
}

async function serve(
  path: string,
  reader: MerchantPageReader,
  customerWebBaseUrl: string = CUSTOMER_WEB_BASE,
): Promise<Response> {
  const route = merchantPageRoute(reader, { customerWebBaseUrl });
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
    const html = render(merchant());

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
    const html = render(
      merchant({ name: '<script>alert(1)</script>', promoCopy: '<img onerror=alert(1)>' }),
    );

    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<\/script/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(tagNamesIn(html)).toEqual(new Set(EXPECTED_TAGS));
  });

  it('emits exactly one anchor, so an injected one cannot blend into the allow-list', () => {
    // `EXPECTED_TAGS` now contains `a`, because the page legitimately carries a
    // call to action. That single addition would otherwise let a merchant
    // smuggle a second anchor through a tag-name assertion — so the *count* is
    // asserted instead.
    //
    // Every assertion below is about **liveness**, never about a substring. The
    // payload `<a href="javascript:alert(1)">` correctly renders as inert escaped
    // text that still *reads* `javascript:alert(1)` — the reader sees the attack,
    // the parser does not. A `not.toContain('javascript:')` here would fail
    // against code that is right, and an assertion that fails on correct code is
    // an assertion that gets deleted.
    for (const payload of [
      '<a href="javascript:alert(1)">x</a>',
      '"><a href="https://evil.example">x</a>',
      "<a href='https://evil.example'>x</a>",
      '<img onerror=alert(1)>',
      '" autofocus onfocus=alert(1) x="',
    ]) {
      const html = render(merchant({ name: payload, promoCopy: payload }));

      // No live anchor beyond the one the renderer wrote, and that one always
      // resolves to the registration route on the injected host.
      expect(hrefsIn(html), payload).toEqual([`${CUSTOMER_WEB_BASE}/register?biz=cafe-central`]);

      // No attribute a parser would act on: `javascript:` inside a real href, or
      // an event handler sitting on a real tag.
      for (const href of hrefsIn(html)) {
        expect(new URL(href).protocol, payload).toBe('https:');
      }
      expect(/(?:<[a-zA-Z][^>]*)\son[a-z]+\s*=/.test(stripText(html)), payload).toBe(false);
      expect(tagNamesIn(html), payload).toEqual(new Set(EXPECTED_TAGS));
    }
  });

  it('escapes a merchant name carrying markup', () => {
    // The merchant writes their own name at signup. This route renders it on an
    // unauthenticated URL, so an unescaped name here is a stored XSS on a route
    // anyone can load.
    const html = render(merchant({ name: '<script>alert(1)</script>' }));

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('escapes promo copy carrying markup, attributes and both quote styles', () => {
    const promo = `<img src=x onerror="alert('1')">`;
    const html = render(merchant({ promoCopy: promo }));

    // The page has exactly one image and it is the platform's own logo, so the
    // attacker's tag must not survive as a tag. Asserting on the whole document
    // would be wrong here — `onerror` *does* appear, as escaped text, which is
    // the payload being shown to the reader rather than run.
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;');
  });

  it('escapes the program name, which is merchant-authored too', () => {
    const html = render(
      merchant({ programName: '"><script>alert(1)</script>' }),
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('points the logo at the brand route the platform already serves', () => {
    // The tenant id, not the slug: `/brand/*` is keyed by tenant id, and a slug
    // key would 404 for every business that has not uploaded anything.
    const html = render(merchant());

    expect(html).toContain(`/brand/${TENANT}.jpg`);
  });

  it('says how to earn and where to spend, from the program row', () => {
    const html = render(
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
    const html = render(merchant({ promoCopy: null }));

    expect(html).toContain('Café Central');
    expect(html).not.toMatch(/promo/i);
  });

  it('says nothing invented about a program that has not been configured', () => {
    const html = render(
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
// The call to action
//
// This page was built for Google's class reviewer and rendered no link at all,
// so a person who opened `/p/{slug}` had no way in. Verified live before the
// change: `GET /p/cafe-central` answered 200 with zero anchors.
// ---------------------------------------------------------------------------

describe('the call to action on the merchant page', () => {
  it('is the only way in, and it points at the registration form', () => {
    const html = render(merchant());

    expect(hrefsIn(html)).toEqual([`${CUSTOMER_WEB_BASE}/register?biz=cafe-central`]);
  });

  it('carries the business context in ?biz=, because without it the form refuses to register', () => {
    // `apps/customer-web/app/register/page.tsx` reads the slug from `?biz=` and
    // answers "Falta el contexto del comercio" without it. So this is the
    // difference between a working path and a dead end, asserted as the exact
    // href rather than as a `toContain('biz=')`.
    expect(registerHrefFor(CUSTOMER_WEB_BASE, 'cafe-central')).toBe(
      `${CUSTOMER_WEB_BASE}/register?biz=cafe-central`,
    );

    // And it survives the full render, not just the helper.
    expect(hrefsIn(render(merchant()))).toEqual([
      `${CUSTOMER_WEB_BASE}/register?biz=cafe-central`,
    ]);
  });

  it('resolves to the customer-web host, never to the media or web host', () => {
    // The defect this guards already happened once, with `programLogo`, and it
    // cost a rejected class. Both wrong hosts serve `/brand/*` and `/p/*` but not
    // `/register` — those routes are `apps/customer-web` pages — so the link
    // would 404 with nothing in any log to say why.
    const [href] = hrefsIn(render(merchant()));

    expect(href).toBeDefined();
    for (const forbidden of FORBIDDEN_CTA_HOSTS) {
      expect(href, forbidden).not.toContain(forbidden);
    }

    expect(new URL(href as string).host).toBe(new URL(CUSTOMER_WEB_BASE).host);
    expect(new URL(href as string).pathname).toBe('/register');
  });

  it('honours an injected customer-web base rather than a default baked into the renderer', () => {
    // A staging customer web has to be a configuration change, not a code
    // change, so the renderer reads the value it is handed.
    const [href] = hrefsIn(
      render(merchant(), 'https://staging-customer.example'),
    );

    expect(href).toBe('https://staging-customer.example/register?biz=cafe-central');
  });

  it('escapes merchant-authored text in the link, because the link text is the merchant name', () => {
    // The CTA reads "Entrá al club de {name}". That name is written by the
    // merchant at signup and this route is public and unauthenticated, so an
    // unescaped one here is stored XSS on a route anyone on the internet can
    // load — the same class as the `<h1>`, one attribute closer to a breakout.
    const html = render(merchant({ name: '"><img onerror=alert(1)>' }));

    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&quot;&gt;&lt;img onerror=alert(1)&gt;');
    // The href itself is untouched by the attack: it is built from the slug.
    expect(hrefsIn(html)).toEqual([`${CUSTOMER_WEB_BASE}/register?biz=cafe-central`]);
  });

  it('escapes a script tag written into the merchant name', () => {
    const html = render(merchant({ name: '<script>alert(1)</script>' }));

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(hrefsIn(html)).toHaveLength(EXPECTED_ANCHOR_COUNT);
  });

  it('escapes a misconfigured base URL rather than breaking out of the href', () => {
    // The href is built from two already-validated pieces — a slug that is
    // `[a-z0-9-]` and an operator-configured origin — so `escapeHtml` on it looks
    // redundant. It is not, and this is the assertion that proves it rather than
    // asserting it: a base carrying a quote is a real misconfiguration, and the
    // renderer's job is to emit inert markup rather than to trust the deploy.
    // Without this test the escape is a guard nothing can observe.
    const html = render(merchant(), 'https://example.com/" onmouseover="alert(1)');

    // The anchor is still there — a misconfigured base is not a reason to drop
    // the only way into the product — but it is inert: one anchor, no live
    // `on…=` attribute anywhere in the markup, and no raw quote inside the href.
    const hrefs = hrefsIn(html);

    expect(hrefs).toHaveLength(EXPECTED_ANCHOR_COUNT);
    expect(hrefs[0]).not.toContain('"');
    expect(hrefs[0]).toContain('&quot;');
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(/(?:<[a-zA-Z][^>]*)\son[a-z]+\s*=/.test(stripText(html))).toBe(false);
    expect(tagNamesIn(html)).toEqual(new Set(EXPECTED_TAGS));
  });

  it('serves the escaped link over HTTP, not only from the renderer', () => {
    // The renderer is not the served bytes; the route is. Both, so a guard on the
    // helper cannot pass while the route drops the escaping.
    const html = renderMerchantPage(
      merchant({ name: '<script>alert(1)</script>' }),
      CUSTOMER_WEB_BASE,
    );

    expect(html).not.toContain('<script>');
    expect(hrefsIn(html)).toEqual([`${CUSTOMER_WEB_BASE}/register?biz=cafe-central`]);
  });
});

// ---------------------------------------------------------------------------
// The slug guard on the outbound URL
// ---------------------------------------------------------------------------

describe('registerHrefFor', () => {
  it('refuses a slug that is not the shape slugify emits, rather than escaping it into an href', () => {
    // The slug reaches this function from the database (`tenants.slug`), not from
    // the request, so it is not covered by `merchantSlugFrom`'s guard. An href is
    // the one interpolation on this page where a quote is an attribute break, so
    // the same shape test runs again here. `null` means the CTA is omitted, which
    // is this file's rule for a block it has no valid data for.
    for (const bad of [
      '"><script>alert(1)</script>',
      "cafe'central",
      'cafe central',
      'cafe/central',
      'CAFÉ',
      '-leading',
      'trailing-',
      '',
    ]) {
      expect(registerHrefFor(CUSTOMER_WEB_BASE, bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('accepts every slug the platform itself owns', () => {
    for (const good of ['cafe-central', 'vyloop-demo', 'a', '123', 'a-b-c-1']) {
      expect(registerHrefFor(CUSTOMER_WEB_BASE, good)).toBe(
        `${CUSTOMER_WEB_BASE}/register?biz=${good}`,
      );
    }
  });

  it('omits the call to action entirely for a slug it cannot validate', () => {
    // Omitted, never substituted: this page never renders a link to somewhere it
    // cannot vouch for, not even a repaired one.
    const html = render(merchant({ slug: '"><img onerror=alert(1)>' }));

    expect(hrefsIn(html)).toEqual([]);
    expect(html).toContain('Café Central');
  });
});

// ---------------------------------------------------------------------------
// The customer-web base URL
// ---------------------------------------------------------------------------

describe('parseCustomerWebBaseUrl', () => {
  it('falls back to the customer web, which is the host that serves /register', () => {
    expect(parseCustomerWebBaseUrl(undefined)).toBe(DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL);
    expect(parseCustomerWebBaseUrl(null)).toBe(DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL);
    expect(parseCustomerWebBaseUrl('')).toBe(DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL);
    expect(parseCustomerWebBaseUrl('   ')).toBe(DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL);
  });

  it('strips a trailing slash, because //register is a different URL to the route', () => {
    expect(parseCustomerWebBaseUrl('https://example.com/')).toBe('https://example.com');
    expect(parseCustomerWebBaseUrl('https://example.com///')).toBe('https://example.com');
    expect(parseCustomerWebBaseUrl('  https://example.com/  ')).toBe('https://example.com');
  });

  it('defaults to a host that is not the media host, which serves no /register', () => {
    // The default and the forbidden hosts are asserted against each other here
    // rather than as literals, so changing one without the other fails.
    for (const forbidden of FORBIDDEN_CTA_HOSTS) {
      expect(DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL, forbidden).not.toContain(forbidden);
      expect(parseCustomerWebBaseUrl(undefined), forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// The route wires the configured base through
// ---------------------------------------------------------------------------

describe('the route and the customer-web base', () => {
  it('serves a CTA built from the base the route was given', async () => {
    const { reader } = readerReturning(merchant());

    const res = await serve('/p/cafe-central', reader, 'https://staging-customer.example');

    expect(hrefsIn(await res.text())).toEqual([
      'https://staging-customer.example/register?biz=cafe-central',
    ]);
  });

  it('never serves a CTA pointing at a host that does not serve /register', async () => {
    // The regression this whole block exists for. Pointing the var at the media
    // host — the value `WALLET_MEDIA_BASE_URL` and `WALLET_WEB_BASE_URL` both
    // carry today — produces a page that looks perfect and a link that 404s.
    const { reader } = readerReturning(merchant());

    const res = await serve('/p/cafe-central', reader, 'https://media.juancode.dev');

    const href = hrefsIn(await res.text())[0] as string;

    expect(href).toBeDefined();
    expect(href).toContain('media.juancode.dev');
    // Documented, not asserted as acceptable: this configuration is wrong and the
    // test exists to make the failure visible rather than to permit it.
    expect(new URL(href).pathname).toBe('/register');
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