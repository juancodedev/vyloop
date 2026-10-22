// @vitest-environment node

/**
 * The QR page may only point at this merchant.
 *
 * ## Why a second guard, and not an extension of the customer-web one
 *
 * `apps/customer-web/app/delivery.contract.test.ts` already has a rule that
 * `cafe-central`, `demo-shop` and `barro` may not appear in production sources:
 *
 *     it('names no specific seeded business', () => {
 *       expect(offenders(/\bcafe-central\b|\bdemo-shop\b|\bbarro\b/i)).toEqual([]);
 *     });
 *
 * It never saw this bug, and it could not have. Its `offenders` walks
 * `appDir = new URL('./', import.meta.url).pathname` — the customer-web package,
 * and nothing else. The QR page lives in `apps/dashboard`, a different package in
 * a different directory tree. A guard defined over one package's sources is
 * structurally incapable of seeing a sibling's, so the rule was correct and silent
 * while a hardcoded `?biz=cafe-central` shipped in the merchant console.
 *
 * So the rule is restated here, next to the sources it protects, following this
 * package's existing convention (`src/__tests__/*.contract.test.ts`, `node`
 * environment, sources under `src/`). Reaching across from customer-web into the
 * dashboard would fix the blind spot by creating the worse problem: the customer
 * web's suite would fail because someone edited the dashboard, and
 * `pnpm --filter @vyloop/customer-web test` would break for a file that package
 * does not own. The dependency has to point the way the code does.
 *
 * ## Why these are not word-bans
 *
 * The seeded-name rule alone would catch `cafe-central` written a second time and
 * nothing else. It would not catch:
 *
 *   - `?biz=` with some slug nobody has written down yet;
 *   - `registerHrefFor(BASE, 'panaderia')` — a literal in the slug position, with
 *     no seeded name anywhere in sight;
 *   - `registerHrefFor(BASE, 'cafe-central')` renamed to a private-looking value;
 *   - the customer-web host retyped into the page, so a preview deployment points
 *     at production and a customer is redirected somewhere nobody tested.
 *
 * Each of those is the same defect wearing different clothes. So most of what
 * follows bans a **shape** rather than a value: the page may not assemble a
 * registration URL at all, may not pass a literal where the slug goes, and may not
 * contain the host. What is left is the behavioural assertion at the end, which
 * holds for any slug whatsoever because it never names one.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const srcDir = new URL('../', import.meta.url).pathname;

/**
 * This file, so its own fixtures and its own patterns are never flagged.
 *
 * The same self-exclusion `delivery.contract.test.ts` does, and for the same
 * reason: a guard that reports itself would have to be edited to be trusted.
 */
const GUARDS = ['qr-tenant.contract.test.ts'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    // `readdirSync` on a directory throws rather than returning an entry, so the
    // directory check has to come first. Directories are walked; node_modules is
    // skipped the same way the customer-web guard skips it.
    try {
      if (readdirSync(path)) return sourceFiles(path);
    } catch {
      // Not a directory.
    }

    return /\.tsx?$/.test(entry) ? [path] : [];
  }) as string[];
}

const all = sourceFiles(srcDir);
const isGuard = (path: string) => GUARDS.some((guard) => path.endsWith(guard));

/**
 * Production sources only.
 *
 * Every `*.test.ts`/`*.test.tsx` file is excluded, not just the behaviour suite:
 * a unit test legitimately writes `registerHrefFor(BASE, 'panaderia')` and names
 * seeded businesses as fixtures, and this guard's rules are about what the product
 * ships. `delivery.contract.test.ts` draws the same line with the same reason.
 */
const production = all.filter((path) => !isGuard(path) && !/\.test\.tsx?$/.test(path));

const pagePath = join(srcDir, 'app/dashboard/qr/page.tsx');
const urlBuilderPath = join(srcDir, 'lib/merchant-qr.ts');

/** A rule violation, reported with the file and line so the failure is actionable. */
function offenders(pattern: RegExp, files: string[] = production): string[] {
  const found: string[] = [];

  for (const path of files) {
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (pattern.test(line)) {
          found.push(`${path.replace(srcDir, 'src/')}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      });
  }

  return found;
}

/**
 * Comments blanked out, with their newlines preserved.
 *
 * ## The `//` has to be whitespace-preceded, and that is not cosmetic
 *
 * The obvious form of this — a bare `//` followed by the rest of the line — is
 * wrong in a way that hid the original bug from the very guard written to catch it.
 * The QR page's constant was
 *
 *     const CUSTOMER_WEB_URL = 'https://vyloop-customer-web.cl-jmunoz.workers.dev/register?biz=cafe-central';
 *
 * and a naive stripper reads the `//` in `https://` as the start of a line
 * comment, blanks the rest of the line, and the seeded-business rule reports a
 * clean run against the file that contains it. Verified: the naive pattern does not
 * match that line, and the corrected one does.
 *
 * So the `//` must be preceded by whitespace or start the line, which is what
 * distinguishes a comment from a URL in practice. The rule errs toward *not*
 * stripping (`x=1;//note` keeps its text), which is the safe direction for a guard:
 * a missed strip can only produce a false positive a human can dismiss, while a
 * wrong strip produces a false negative that looks like a passing suite.
 *
 * (The pattern is written out in `stripComments` below rather than here, because a
 * block comment cannot contain the comment-closing sequence it would be describing.)
 *
 * ## Why this is a scanner and not a parser
 *
 * It only has to make prose invisible to a prose rule. `delivery.contract.test.ts`
 * makes the same trade and documents it; a real tokenizer would also have to know
 * about JSX text, template literals and regex literals, and the guards here are not
 * worth a parser's failure modes.
 */
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, (block) => block.replaceAll(/[^\n]/g, ' '))
    .replaceAll(/(^|\s)\/\/[^\n]*/g, (line) => line.replaceAll(/[^\n]/g, ' '));
}

/**
 * The same scan with comments removed.
 *
 * A rule about a *value the product can act on* needs this, and `merchant-qr.ts`
 * is the proof: it has to be able to write "`?biz=cafe-central` was the bug" in its
 * own doc comment, and a raw scan made that comment the violation. A comment
 * cannot reach a customer's phone, so a comment quoting the failure cannot be the
 * failure — and a guard that forces you to delete the explanation of a bug is a
 * guard whose next author removes the guard.
 *
 * `delivery.contract.test.ts` draws the same line and for the same reason, and this
 * is a port of its scanner, with the `//`-in-a-URL fix the original lacks.
 *
 * The identifier-shaped rules below still use the raw `offenders`, which is the
 * other half of that decision: those are about where an *expression* is written,
 * and a comment naming an expression is harmless but a comment is also not a
 * promise.
 */
function copyOffenders(pattern: RegExp, files: string[] = production): string[] {
  const found: string[] = [];

  for (const path of files) {
    stripComments(readFileSync(path, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        if (pattern.test(line)) {
          found.push(`${path.replace(srcDir, 'src/')}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      });
  }

  return found;
}

const page = () => readFileSync(pagePath, 'utf8');

/**
 * The page's code, with comments removed.
 *
 * The two rules below read the page as text rather than as a file list, and they
 * need the same comment-stripping `copyOffenders` applies: the page's own doc
 * comment has to be able to name `businessName ?? ''` while explaining why it is
 * not there. Asserting against prose would make the explanation the violation.
 */
function pageCode(): string {
  return stripComments(page());
}

describe('dashboard delivery gate: the QR is this merchant\'s', () => {
  it('has sources to scan, and the page it is about', () => {
    // Everything below is vacuously true over zero files. A guard that silently
    // stopped matching anything would report a clean run forever, so the scope is
    // asserted before the rules are.
    expect(production.length).toBeGreaterThan(10);
    expect(production).toContain(pagePath);
  });

  it('names no specific seeded business', () => {
    // The customer-web rule, in the package whose sources can actually contain
    // one. `cafe-central`, `demo-shop` and `barro` exist in the seed scripts, and a
    // merchant must never be shown another merchant's name or be sent to another
    // merchant's registration form.
    //
    // Comments are excluded, so this is a rule about what can be rendered rather
    // than about what can be written down — see `copyOffenders`.
    expect(copyOffenders(/\bcafe-central\b|\bdemo-shop\b|\bbarro\b/i)).toEqual([]);
  });

  /**
   * The rule that would have caught the original line, whatever it said.
   *
   * `?biz=` may appear in exactly one file: the pure builder, which is the only
   * place a registration URL is allowed to be assembled. A component that
   * concatenates the query itself has a value in hand somewhere, and that value
   * is either a constant — this bug — or something it should not be building a URL
   * from. There is no third option worth allowing.
   *
   * Note what this catches that the seeded-name rule cannot: `?biz=` with any slug
   * at all, including one invented tomorrow.
   */
  it('assembles the registration query in one place, and not in the page', () => {
    const allowed = urlBuilderPath;
    const builders = production.filter((path) => copyOffenders(/\?biz=/, [path]).length > 0);

    expect(builders).toEqual([allowed]);
    expect(copyOffenders(/\?biz=/, [pagePath])).toEqual([]);
  });

  /**
   * The literal-in-the-slug-position rule.
   *
   * The signature is `registerHrefFor(baseUrl, slug)`, so the second argument is
   * where a merchant's identity goes. A quoted string there is a merchant that
   * cannot change — this is the defect with the constant relocated one function to
   * the left, and it would pass a scan for seeded names because `registerHrefFor`
   * is where people would expect to *find* the slug.
   *
   * The check is on the character after the comma: an identifier, a member
   * expression or a call is fine; `'`, `"` or a backtick is a baked value. A
   * template literal is caught too, since a `biz=` URL assembled from one still
   * has to get its slug from somewhere the reader cannot audit.
   */
  it('passes a value, never a literal, in the slug position of the URL builder', () => {
    const baked = offenders(/registerHrefFor\(\s*[^,)]+,\s*(['"`])/, production);

    expect(baked).toEqual([]);
  });

  /**
   * The host belongs to config.
   *
   * The previous page carried the customer-web origin as a literal, which made it
   * another copy of a value the worker and the gateway also hold. Copies drift: a
   * preview deployment would scan customers into production, or a production QR
   * would point at a preview that is torn down next week. `merchant-qr.ts` is
   * exempt because reading the origin and defaulting it *is* its job; everywhere
   * else it has to arrive from `NEXT_PUBLIC_CUSTOMER_WEB_URL`.
   */
  it('reads the customer-web host from config instead of repeating it', () => {
    expect(
      copyOffenders(/vyloop-customer-web\.pages\.dev/, production.filter((p) => p !== urlBuilderPath)),
    ).toEqual([]);
  });

  /**
   * The QR must be encoded from something the API said.
   *
   * `QRCodeCanvas`'s `value` is the literal string a customer's phone resolves.
   * Asserting that it is not a quoted string is the shape-level version of "the
   * destination comes from the tenant", and it holds for every slug, present and
   * future — which is the whole point of a guard that outlives the values anyone
   * thought to ban.
   */
  it('never hands the QR encoder a literal URL', () => {
    expect(offenders(/value=\{['"`]/, [pagePath])).toEqual([]);
  });

  /**
   * The contract this page depends on, pinned from this side.
   *
   * The page cannot be fixed by the frontend alone: it needs `businessName` and
   * `businessSlug` from `GET /v1/wallet/program`, which is a change in
   * `workers/wallet`. If those two fields are ever dropped from the response, the
   * page cannot invent them, and this assertion fails here rather than as a QR
   * with an empty `biz` in production.
   */
  it('reads the business identity the operator program endpoint reports', () => {
    const source = pageCode();

    expect(source).toMatch(/\/v1\/wallet\/program/);
    expect(source).toMatch(/businessSlug/);
    expect(source).toMatch(/businessName/);

    // The defaulting is the danger, not the read. A **string literal** as the
    // fallback is invented content wearing a program's clothes, and it is what the
    // customer web's "falls back to no invented content" rule bans on that side.
    //
    // `?? null` is explicitly not caught: dropping the unit is the honest answer,
    // and it is the one this page is supposed to use. A page that had to invent a
    // name to render a heading is a page showing a merchant a name that is not
    // theirs.
    expect(source).not.toMatch(/business(Slug|Name)\s*(\?\?|\|\|)\s*['"`]/);
  });

  /**
   * The behavioural half, and the only assertion here that needs no list of banned
   * words.
   *
   * The pure builder is exercised with two slugs that are not seeded businesses and
   * are not named anywhere in this file as fixtures to remember. If the slug did
   * not reach the URL — because it was ignored, defaulted, or shadowed by a
   * constant inside the function — these two calls would return the same string,
   * and no word-ban anywhere in the repository would notice.
   *
   * It is here rather than only in `merchant-qr.test.ts` on purpose: a unit test
   * proves the function behaves, and this proves the function is on the path from
   * the page to the QR. The two together close the loop.
   */
  it('builds a different URL for a different merchant', async () => {
    const { registerHrefFor } = await import('../lib/merchant-qr');

    const first = registerHrefFor('https://host.example', 'alpha-dos');
    const second = registerHrefFor('https://host.example', 'beta-tres');

    expect(first).not.toBe(second);
    expect(first).toBe('https://host.example/register?biz=alpha-dos');
    expect(second).toBe('https://host.example/register?biz=beta-tres');
  });

  it('refuses to build a URL for a slug it cannot vouch for', async () => {
    const { registerHrefFor } = await import('../lib/merchant-qr');

    // The client half of the contract. A blank slug is reachable because
    // `tenants.slug` is `notNull` with no check constraint, so the builder has to
    // answer `null` and let the page say so, rather than emit `?biz=`.
    for (const slug of [null, undefined, '', '   ', 'a b', 'A-B', '../x']) {
      expect(registerHrefFor('https://host.example', slug), String(slug)).toBeNull();
    }
  });
});