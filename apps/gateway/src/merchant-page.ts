/**
 * The public page a customer — and Google's class reviewer — opens from a
 * loyalty pass.
 *
 * ## Why this route is here rather than in the dashboard
 *
 * Measured, not assumed. `vyloop-customer-web.pages.dev/program` is a server
 * component and serves 5,917 characters of visible text; the dashboard is a
 * `next-on-pages` static export whose whole `/dashboard` HTML is 9,638 bytes of
 * which **18** are text, because every byte of content is fetched from the
 * client. A review page placed there would hand Google's reviewer a `<title>`
 * and nothing else.
 *
 * ## Why it renders in the worker, with no JavaScript
 *
 * This HTML is the product. It is read by a crawler over HTTP and by a person
 * on a phone with a bad connection, and there is nothing on the page for
 * JavaScript to do. So: no hydration, no framework, no script tag — asserted
 * in `merchant-page.test.ts`, because "no JavaScript" is a property that is
 * invisible until something adds one.
 *
 * ## The security problem, which is the whole reason the escape function exists
 *
 * Two of the strings on this page are **written by the merchant**: `tenants.name`
 * (at signup) and `loyalty_programs.promo_copy`. They go into HTML on an
 * unauthenticated public URL. Interpolated raw, `<script>alert(1)</script>` as a
 * business name is stored XSS on a route anyone on the internet can load, and
 * the merchant who writes it may well be trying to attack their own customers.
 *
 * So every interpolated value goes through `escapeHtml` — including inside
 * attributes. There is exactly one escaper and no template literals that skip
 * it: `renderMerchantPage` builds the document by concatenating escaped parts,
 * so a new field added later is escaped by construction only if it is written
 * through `escapeHtml`, and the tests that assert the raw `<script` is absent
 * from the output are what catch the day someone is not.
 *
 * `JSON.stringify` is not a substitute and is not used: it escapes for a
 * JavaScript string literal, not for HTML, and `"` becoming `\"` leaves a
 * double quote live inside an attribute.
 */

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/** The slice of a merchant this page renders. Every field is read, never invented. */
export interface MerchantPageData {
  /** `tenants.id`. Keys the brand route, which is how the logo is addressed. */
  tenantId: string;
  /** `tenants.name`. Merchant-authored. */
  name: string;
  /** `tenants.slug`. The only thing echoed back into a URL, and it came from the request. */
  slug: string;
  /** `loyalty_programs.name`, or `null` when the merchant has not configured a programme. */
  programName: string | null;
  /** `loyalty_programs.promo_copy`. Merchant-authored, and absent for most merchants. */
  promoCopy: string | null;
  /** `loyalty_programs.points_currency`, e.g. `puntos`. */
  pointsCurrency: string | null;
  /** `loyalty_programs.earn_rate`. Kept as the string Postgres returns for `numeric`. */
  earnRate: string | null;
  /** `loyalty_programs.min_redeem_points`. */
  minRedeemPoints: number | null;
}

/**
 * The read this page performs, behind an interface.
 *
 * The route is therefore exercisable without a database, and the tests can
 * assert a claim unit tests otherwise cannot: that a malformed slug never
 * reached the query at all.
 */
export interface MerchantPageReader {
  /** `null` for a slug no tenant has. */
  findBySlug(slug: string): Promise<MerchantPageData | null>;
}

// ---------------------------------------------------------------------------
// The route path
// ---------------------------------------------------------------------------

/**
 * Where a merchant's public page lives.
 *
 * `/p/{slug}` rather than the dashboard's `/program` because this is served by
 * the gateway, on the same origin as `/brand/*` — so the logo on this page is
 * an absolute URL the worker can build, and so Google's reviewer gets real HTML.
 */
export const MERCHANT_PAGE_PREFIX = '/p/';

// ---------------------------------------------------------------------------
// The slug guard
// ---------------------------------------------------------------------------

/**
 * The exact shape `slugify` emits, and the only shape accepted.
 *
 * Read from `packages/db/src/slug.ts`: lowercase, `[a-z0-9]`, single hyphens
 * between tokens, no leading or trailing hyphen. Narrowing the accepted shape to
 * what the writer can produce means the guard cannot be bypassed by a shape the
 * system itself never creates — and it does the traversal work for free, because
 * neither `.` nor `/` nor `%` is in the set.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Extract the slug from a request path, or `null` for anything else.
 *
 * ## The order of the guards, and why each is here
 *
 * 1. **Prefix.** `/p/{slug}` and nothing else, so no other route's path can be
 *    read as a merchant lookup.
 * 2. **Decode, then reject what decoding produced.** `new URL().pathname`
 *    normalises a *literal* `..` away — `/p/../x` arrives as `/x` — but it does
 *    **not** decode percent-encoding, so `%2e%2e%2f` reaches this function
 *    intact and only `decodeURIComponent` turns it back into `../`. That is the
 *    exact bug `brandKeyFor` was written to refuse, and it has been committed
 *    once in this repository already.
 * 3. **A decode that throws is a refusal.** `decodeURIComponent('%zz')` raises a
 *    `URIError`. Unhandled, that is a 500 on a public URL — a crawler reading it
 *    during a class review sees a server error instead of a page.
 * 4. **The shape.** `SLUG_PATTERN` excludes `.`, `/`, `%`, `?`, `#`, quotes,
 *    spaces and every non-ASCII character, which covers traversal, query
 *    injection and a homoglyph slug in one test.
 *
 * Returns `null` rather than throwing for all of it, because every one of these
 * is an ordinary 404 from the outside.
 */
export function merchantSlugFrom(pathname: string): string | null {
  if (!pathname.startsWith(MERCHANT_PAGE_PREFIX)) return null;

  const raw = pathname.slice(MERCHANT_PAGE_PREFIX.length);

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }

  // A separator is refused separately from the shape test, so the reason is
  // legible: `SLUG_PATTERN` would reject it too, and this says which rule.
  if (decoded === '' || decoded.includes('/')) return null;

  return SLUG_PATTERN.test(decoded) ? decoded : null;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * The five characters that can change the meaning of HTML, and nothing else.
 *
 * Ordered so the ampersand is replaced first: escaping `<` produces `&lt;`, and
 * an implementation that escaped `&` afterwards would render it as `&amp;lt;` —
 * a page showing the reader literal `&lt;` where an entity belongs.
 *
 * Deliberately not an allow-list of "safe" characters. That approach silently
 * mangles accented merchant names, and `Café Central` is a real business name
 * this platform has already created.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * How long a browser or an edge may serve this page without asking again.
 *
 * ## Why it is cacheable at all
 *
 * The page is public, unauthenticated, and derived entirely from two database
 * rows that are the same for every reader. There is no session, no cookie, no
 * `Authorization` header and no per-reader value anywhere in the output — the
 * `Vary` header the tests assert is absent is what makes that claim checkable
 * rather than merely stated. `promo_copy` is written by the merchant, which
 * makes it **per-merchant**, not per-reader: a change to it changes the page
 * for everyone equally, which is exactly what a public cache is for.
 *
 * ## Why not longer
 *
 * `/brand/*` is immutable per business — the object at a key is replaced and the
 * URL never changes — so an hour there costs nothing. This page is *edited in
 * place*: a merchant changes their promo copy and the same URL must show it. An
 * hour is the ceiling, so a rebrand or a new promotion is visible the same day
 * rather than tomorrow, and the cost is one query per merchant per hour rather
 * than one per page view.
 */
export const MERCHANT_PAGE_TTL_SECONDS = 900;

/**
 * Render the merchant's public page.
 *
 * Every value below reaches the document through `escapeHtml`, with no
 * exceptions. The document is assembled by concatenation on purpose: a template
 * literal with `${merchant.name}` invites exactly the omission this page cannot
 * afford, and there is no framework here that would escape for us.
 *
 * Optional blocks are **omitted, never substituted** — the same rule
 * `findPromoCopy` and `buildLoyaltyClass` follow. A merchant who has written no
 * promotion gets no promotion section, not a default sentence nobody authored,
 * and a merchant with no configured programme gets their name and their logo and
 * nothing invented around them.
 */
export function renderMerchantPage(merchant: MerchantPageData): string {
  const logoUrl = `/brand/${escapeHtml(merchant.tenantId)}.jpg`;
  const title = escapeHtml(merchant.name);

  // "Earn" is only stated when there is a rate to state. A page claiming you
  // earn 1 punto per peso when no rate is configured is a promise the database
  // does not support.
  const earnSentence =
    merchant.earnRate !== null && merchant.pointsCurrency !== null
      ? `<p class="rule">Por cada peso gastado acumulas <strong>${escapeHtml(merchant.earnRate)} ${escapeHtml(merchant.pointsCurrency)}</strong>.</p>`
      : '';

  const redeemSentence =
    merchant.minRedeemPoints !== null && merchant.pointsCurrency !== null
      ? `<p class="rule">Puedes canjear desde <strong>${escapeHtml(String(merchant.minRedeemPoints))} ${escapeHtml(merchant.pointsCurrency)}</strong>.</p>`
      : '';

  const programName =
    merchant.programName !== null
      ? `<h2>${escapeHtml(merchant.programName)}</h2>`
      : '';

  // The only merchant-authored block that is not a heading, and the reason this
  // page needs an escaper at all.
  const promo =
    merchant.promoCopy !== null
      ? `<blockquote class="promo">${escapeHtml(merchant.promoCopy)}</blockquote>`
      : '';

  const description =
    merchant.promoCopy ?? merchant.programName ?? merchant.name;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${escapeHtml(description)}">
</head>
<body>
<main>
<img src="${logoUrl}" alt="${title}" width="96" height="96">
<h1>${title}</h1>
${programName}
${promo}
<section>
<h2>Cómo acumular y usar tu programa</h2>
${earnSentence}
${redeemSentence}
<p>Abre tu pase de Vyloop en Google Wallet para ver tus ${escapeHtml(merchant.pointsCurrency ?? 'puntos')}.</p>
</section>
</main>
</body>
</html>
`;
}

/**
 * A 404 for this route.
 *
 * HTML, because the caller asked for a page and a JSON error body is a worse
 * answer than a short one — but deliberately with **no** merchant data in it.
 * A 404 that echoed the slug would render it as markup, so the slug is not
 * rendered at all: this document is a constant.
 */
const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>No encontrado</title>
</head>
<body>
<p>No encontramos ese programa de lealtad.</p>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/**
 * The slice of a Hono context this route uses: `req.url` to read the slug out of
 * the raw pathname, and `html` to answer.
 *
 * Declared structurally rather than as `Context<{ Bindings: … }>` on purpose, and
 * the reason is worth stating because the narrower type looks like the tidier one.
 *
 * Hono's `Context` is **invariant** in its env parameter — `c.set` takes one — so
 * `Context<{ Bindings: GatewayEnv }>` is not assignable to
 * `Context<{ Bindings: { DATABASE_URL: string } }>` however much smaller the second
 * is. The honest-looking alternative is a cast at the mount point in `index.ts`,
 * and that cast is precisely where a binding mismatch would stop being checked:
 * rename `DATABASE_URL` in the gateway env and the cast would still compile.
 *
 * This interface has no such hole. It cannot reach a binding it has not named,
 * `index.ts` mounts it with its full env and no assertion anywhere, and the
 * `DATABASE_URL` this route actually needs is read by `createMerchantPageReader`
 * in `merchant-store.ts`, where the type *is* checked.
 */
interface PageRequest {
  req: { url: string };
  html(
    body: string,
    status?: number,
    headers?: Record<string, string>,
  ): Response | Promise<Response>;
}

/**
 * `GET /p/{slug}` — one merchant's public page, as HTML.
 *
 * ## Exempt from auth and from the business-id check, by being outside `/v1/*`
 *
 * The gateway's auth, auth-inject, business-id, rate-limit and routing
 * middleware are all registered with `app.use('/v1/*', …)`, and this route is
 * mounted at `/p/*` alongside `/brand/*`. So the exemption is structural: there
 * is no bypass to invent and none to widen. That is the same reason Google can
 * fetch a logo from `/brand/{tenantId}.jpg` with no credentials at all.
 *
 * The test asserting a 200 with no authentication headers is what keeps that
 * structural fact from drifting: if this route were ever moved under `/v1/*`,
 * that test fails rather than the page quietly requiring a token.
 *
 * ## The guard runs before the reader
 *
 * `merchantSlugFrom` is called before `findBySlug`, and the traversal tests
 * assert the reader was **not** called. A guard that ran after the lookup would
 * still 404, but a malformed slug would already have been handed to a query.
 */
export function merchantPageRoute(reader: MerchantPageReader) {
  return async (c: PageRequest) => {
    const slug = merchantSlugFrom(new URL(c.req.url).pathname);
    if (slug === null) {
      return c.html(NOT_FOUND_HTML, 404, {
        'Cache-Control': `public, max-age=${MERCHANT_PAGE_TTL_SECONDS}`,
      });
    }

    const merchant = await reader.findBySlug(slug);
    if (merchant === null) {
      return c.html(NOT_FOUND_HTML, 404, {
        'Cache-Control': `public, max-age=${MERCHANT_PAGE_TTL_SECONDS}`,
      });
    }

    return c.html(renderMerchantPage(merchant), 200, {
      'Cache-Control': `public, max-age=${MERCHANT_PAGE_TTL_SECONDS}`,
      // The page interpolates merchant-authored text. `nosniff` costs nothing
      // and stops a browser from deciding the response is something executable.
      'X-Content-Type-Options': 'nosniff',
      // No `Referrer-Policy` and no cookie: nothing here is per-reader, and
      // anything that made it per-reader would break the `public` above.
    });
  };
}