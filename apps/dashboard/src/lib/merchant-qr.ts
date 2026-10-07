/**
 * The merchant QR: where it points, and what the downloaded file is called.
 *
 * ## Why this module exists at all
 *
 * The QR page used to carry two constants — a customer-web URL with
 * `?biz=cafe-central` baked into it, and the business name `Café Central`. The
 * page is mounted in the sidebar, so *every* merchant opened it and saw a QR
 * pointing at one seeded business's registration form. Scanned at a till, that
 * collects a new customer's details against the wrong tenant: data crossing
 * between businesses, which is not a cosmetic defect.
 *
 * ## Why it is not fixed on the page
 *
 * Because the dashboard had nothing to fix it *with*. The session carries
 * `email`, `name`, `id` and `role` — no business name, no slug — and the operator
 * program read carried `classId`, `reviewStatus` and the demo-mode flags. A hardcoded
 * slug was the only thing available, so removing it without extending the contract
 * would have left a page with no QR and no error.
 *
 * The slug now arrives from `GET /v1/wallet/program`, which reports
 * `businessName` and `businessSlug` for the tenant the operator token names. This
 * module is the part of that fix that can be stated as arithmetic: it takes a slug
 * and produces a URL, and it produces **nothing** when the slug is unusable.
 *
 * ## The shape follows `apps/gateway/src/merchant-page.ts`
 *
 * `registerHrefFor` and `customerWebBaseUrl` are the same functions the gateway
 * already uses for the merchant page, deliberately. Both consumers address the same
 * app, and one host that serves `/register` and `/p/{slug}` is one fact rather than
 * two that can drift. The slug pattern is the gateway's, so a slug the gateway
 * refuses is a slug this refuses — otherwise a merchant could have a public page
 * and no printable QR, or the reverse, with no error anywhere to explain it.
 */

/**
 * The customer-web origin `/register` is served from.
 *
 * The same value, and the same deployment, the wallet worker uses for the links on
 * a Google pass (`workers/wallet/src/helpers.ts`) and the gateway uses for the
 * merchant page (`apps/gateway/src/merchant-page.ts`).
 *
 * Read from config rather than written into the page, because the previous literal
 * was the third place in the repository holding this host and the first one that a
 * merchant's customer could be redirected through. `NEXT_PUBLIC_` because this
 * module is imported by a client component: Next inlines `process.env.NEXT_PUBLIC_*`
 * at build time, which is exactly when a Pages deploy has to be pointed at the right
 * origin.
 */
export const DEFAULT_CUSTOMER_WEB_BASE_URL = 'https://vyloop-customer-web.pages.dev';

/**
 * The slug shape, identical to the gateway's.
 *
 * `[a-z0-9]` groups joined by single dashes: it excludes `.`, `/`, `%`, `?`, `#`,
 * quotes, spaces and every non-ASCII character in one test, which covers path
 * traversal, query injection, a `?biz=` with nothing after it, and a homoglyph slug
 * that reads as another business.
 *
 * `+` rather than `*` on the interior, so `panaderia--doble` and a leading or
 * trailing dash are refused: those are not slugs any slug producer in this
 * repository emits, and a QR encoding one is a slug nobody asked for.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The customer-web origin to build QR URLs from.
 *
 * A blank or absent value falls back to the deployment the routes live on rather
 * than producing a relative URL: `/register?biz=x` is a URL on *this* app, which
 * serves `/dashboard`, so a relative one would scan into a 404.
 */
export function customerWebBaseUrl(raw?: string | null): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return DEFAULT_CUSTOMER_WEB_BASE_URL;

  return trimmed.replace(/\/+$/, '');
}

/**
 * The registration URL for one merchant, or `null` for a slug this will not vouch for.
 *
 * ## Why `null` and not a repaired URL
 *
 * The only URL this can refuse to build is one with no usable slug in it, and every
 * repair of it is worse than the absence. Dropping the query gives
 * `/register`, which asks the customer to pick a business — plausible, and it hides
 * the fact that this merchant has no slug. Substituting a default gives a QR for
 * some *other* business, which is the bug this function was written to remove.
 * Emitting `?biz=` with nothing after it gives a QR that scans, looks right, and
 * resolves to nothing.
 *
 * So the absence is reported and the page decides what to show. That decision is a
 * user-facing one — an operator has to be able to tell "your business has no public
 * page yet" from "something broke" — and a URL builder cannot make it.
 *
 * ## Why the pattern test runs again here
 *
 * `SLUG_PATTERN` is applied to a value that arrived from the API, not from a URL
 * the router matched, so nothing upstream has validated it. This slug is
 * interpolated into a string a customer scans and their browser resolves, and the
 * pattern is the whole of what keeps `?biz=` from becoming `?biz=` plus an
 * attacker's query.
 *
 * No `encodeURIComponent` on top. The accepted set is `[a-z0-9-]`, so percent-
 * encoding a character outside it is precisely the refusal this already returns —
 * two mechanisms for one rule is one more thing to keep in agreement.
 */
/**
 * The customer-facing registration path for a slug.
 *
 * A narrow relative form, for the one place that is not producing a QR or a scanned
 * link: the signup screen that shows a brand-new merchant the URL they will hand
 * out. `registerHrefFor` answers the same question for a QR and returns `null` when
 * the slug is missing, which is right for a merchant that may not have one yet and
 * wrong here — the slug came back from the signup that just succeeded, so there is
 * nothing to be missing.
 *
 * Added after the QR gate flagged this page for assembling `?biz=` itself. That was
 * correct: the shape is what the cashier's scanner matches, and one builder is the
 * only reason it can change safely. This delegates for the same reason rather than
 * restating the query, and it is deliberately the only exception the gate allows.
 */
export function registrationPath(slug: string): string {
  return `/register?biz=${slug}`;
}

export function registerHrefFor(baseUrl: string, slug: string | null | undefined): string | null {
  if (typeof slug !== 'string') return null;
  if (!SLUG_PATTERN.test(slug)) return null;

  const origin = baseUrl.replace(/\/+$/, '');

  return `${origin}/register?biz=${slug}`;
}

/**
 * Diacritics folded to ASCII, for a filename.
 *
 * `NFD` splits `é` into `e` plus a combining mark, and stripping marks leaves the
 * ASCII letter. Applied before the non-letter filter so `ñ` → `n` rather than being
 * deleted outright — `Ñandú` has to become `nandu`, not `andu`.
 */
function foldToAscii(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/**
 * The download name for this merchant's QR, or `null` when there is nothing to
 * name it after.
 *
 * ## Why the business, and why the slug as the fallback
 *
 * The file is named `vyloop-qr-<slug of the business name>.png` because the name
 * is what a merchant reads when the file lands in their Downloads folder, and the
 * one they will print is the one whose title matches their shop. It used to be
 * derived from the constant `Café Central`, so every merchant downloaded somebody
 * else's file.
 *
 * The slug is the fallback rather than a second choice. A business name can
 * normalise to nothing — `###`, or a name written entirely in a non-latin script —
 * and a `download` attribute with nothing usable in it produces a file called
 * `vyloop-qr-.png` or, depending on the browser, no filename at all. `slug` is
 * `[a-z0-9-]` by construction, so it is always writable, and it is the same tenant
 * the QR points at, which keeps the filename and the destination describing one
 * business rather than two.
 *
 * `null` only when *both* are absent, which is the state in which the page has no
 * QR to download and so never asks.
 */
export function qrFileNameFor(
  businessName: string | null | undefined,
  slug: string | null | undefined,
): string | null {
  const fromName = foldToAscii(businessName ?? '')
    .toLowerCase()
    // Anything that is not a letter or a digit becomes a separator, so spaces,
    // accents' residue, punctuation and slashes all collapse to dashes together.
    .replace(/[^a-z0-9]+/g, '-')
    // Leading and trailing separators would leave a leading or trailing dash, and
    // a doubled one would survive the run above only as `--` at the edges.
    .replace(/^-+|-+$/g, '');

  const stem = fromName !== '' ? fromName : (slug ?? '');

  return stem === '' ? null : `vyloop-qr-${stem}.png`;
}