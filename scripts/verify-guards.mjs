/**
 * Mutation verification for the guards added by `feat/loyalty-pass-presentation`.
 *
 * ## Why this file exists at all
 *
 * This repository has a documented history of two things going wrong in the same
 * way: tests written that pass without proving anything, and "mutations" that
 * were never actually applied — a Python heredoc that exited 0 while doing
 * nothing, leaving a test green over unchanged code. A test that passes against a
 * change that did not happen is worse than no test, because it is reported as
 * coverage.
 *
 * So every mutation here is checked twice:
 *
 * 1. **The edit landed.** `git diff` is consulted after writing, and a mutation
 *    whose file is byte-identical is reported as `NO-OP` and its result is
 *    discarded rather than counted. A silently-ineffective mutation that reports
 *    green is the exact trap; a loudly-ineffective one is just a broken tool.
 * 2. **A test caught it.** Only a *failing* test counts as verification. A
 *    mutation that leaves the suite green is `MISSED`, which means the guard is
 *    not load-bearing and the test claiming to cover it is decoration.
 *
 * ## Usage
 *
 *     node scripts/verify-guards.mjs
 *
 * Read-only with respect to the repository: every file it touches is restored
 * from an in-memory copy, and a final `git status` comparison proves it.
 *
 * Development tool: kept beside the script it verifies, outside `src`, so it is
 * neither linted nor typechecked as product code — same convention as
 * `check-wallet-readiness.mjs`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = process.cwd();

/**
 * Every guard this change adds, and the test that must fail when it is removed.
 *
 * `dir` is the vitest project the assertions live in, so the run stays fast
 * instead of exercising the whole monorepo once per mutation.
 *
 * `from` / `to` are exact substrings. A mutation whose anchor is not found is a
 * hard error, not a skip: a guard that has been refactored away makes this file
 * obsolete, and it should say so rather than quietly verify nothing.
 */
const MUTATIONS = [
  // ==========================================================================
  // 1. The escaper — the most important guard in the change
  // ==========================================================================
  {
    label: 'escapeHtml: stop escaping `<`',
    file: 'apps/gateway/src/merchant-page.ts',
    from: ".replaceAll('<', '&lt;')",
    to: ".replaceAll('<', '<')",
    dir: 'apps/gateway',
    expect: /escapes a merchant name carrying markup/,
  },
  {
    label: 'escapeHtml: stop escaping `>`',
    file: 'apps/gateway/src/merchant-page.ts',
    from: ".replaceAll('>', '&gt;')",
    to: ".replaceAll('>', '>')",
    dir: 'apps/gateway',
    expect: /escapes a merchant name carrying markup/,
  },
  {
    label: 'escapeHtml: stop escaping `"`',
    file: 'apps/gateway/src/merchant-page.ts',
    from: '.replaceAll(\'"\', \'&quot;\')',
    to: '.replaceAll(\'"\', \'"\')',
    dir: 'apps/gateway',
    expect: /escapes promo copy carrying markup/,
  },
  {
    label: "escapeHtml: stop escaping `'`",
    file: 'apps/gateway/src/merchant-page.ts',
    from: ".replaceAll(\"'\", '&#39;')",
    to: ".replaceAll(\"'\", \"'\")",
    dir: 'apps/gateway',
    expect: /escapes promo copy carrying markup/,
  },
  {
    label: 'escapeHtml: escape `&` last instead of first, so entities double-escape',
    // The subtlest one: every individual assertion still passes, because `<`
    // still becomes `&lt;`. What breaks is that `&lt;` also becomes
    // `&amp;lt;`, and the page renders literal `&lt;` to the reader.
    file: 'apps/gateway/src/merchant-page.ts',
    from: `  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')`,
    to: `  return value
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('&', '&amp;')`,
    dir: 'apps/gateway',
    expect: /amp;lt/,
  },

  // ==========================================================================
  // 2. The page carries no script and only our own tags
  // ==========================================================================
  {
    label: 'renderMerchantPage: interpolate the merchant name raw',
    file: 'apps/gateway/src/merchant-page.ts',
    from: '<h1>${title}</h1>',
    to: '<h1>${merchant.name}</h1>',
    dir: 'apps/gateway',
    expect: /escapes a merchant name carrying markup|carries no script/,
  },
  {
    label: 'renderMerchantPage: interpolate promo copy raw',
    file: 'apps/gateway/src/merchant-page.ts',
    from: '<blockquote class="promo">${escapeHtml(merchant.promoCopy)}</blockquote>',
    to: '<blockquote class="promo">${merchant.promoCopy}</blockquote>',
    dir: 'apps/gateway',
    expect: /escapes promo copy carrying markup|carries no script/,
  },
  {
    label: 'renderMerchantPage: interpolate the program name raw',
    file: 'apps/gateway/src/merchant-page.ts',
    from: '? `<h2>${escapeHtml(merchant.programName)}</h2>`',
    to: '? `<h2>${merchant.programName}</h2>`',
    dir: 'apps/gateway',
    expect: /escapes the program name/,
  },

  // ==========================================================================
  // 3. The slug guard, before any database access
  // ==========================================================================
  {
    label: 'merchantSlugFrom: drop the decoded-shape check entirely',
    file: 'apps/gateway/src/merchant-page.ts',
    from: 'return SLUG_PATTERN.test(decoded) ? decoded : null;',
    to: 'return decoded === "" ? null : decoded;',
    dir: 'apps/gateway',
    expect: /refuses a slug carrying a separator|refuses only the shape|encoded traversal/,
  },
  {
    label: 'merchantSlugFrom: decode nothing, so an encoded hyphen stops resolving',
    // Previously written as "drop the decode" and reported MISSED, which was a
    // true result about a badly-aimed mutation rather than about the guard: with
    // no decode, `%2e%2e%2f` is still refused, because `SLUG_PATTERN` excludes
    // `%`. So the decode's real load-bearing job was never under test.
    //
    // It is this one. A percent-encoded hyphen is a legal encoding of a slug the
    // platform owns, and it resolves to that merchant when the path is decoded.
    // Without the decode it is refused — a merchant whose URL reaches them from a
    // client that encoded it gets a 404 on a page that exists.
    file: 'apps/gateway/src/merchant-page.ts',
    from: '  let decoded: string;\n  try {\n    decoded = decodeURIComponent(raw);\n  } catch {\n    return null;\n  }',
    to: '  const decoded = raw;',
    dir: 'apps/gateway',
    expect: /encoded hyphen|decodes a percent-encoded slug/,
  },
  {
    label: 'merchantSlugFrom: let a throwing decode propagate instead of returning null',
    file: 'apps/gateway/src/merchant-page.ts',
    from: '  } catch {\n    return null;\n  }',
    to: '  } catch (err) {\n    throw err;\n  }',
    dir: 'apps/gateway',
    expect: /malformed percent-encoding|404s a malformed slug/,
  },
  {
    label: 'merchantSlugFrom: drop the prefix check',
    file: 'apps/gateway/src/merchant-page.ts',
    from: "if (!pathname.startsWith(MERCHANT_PAGE_PREFIX)) return null;",
    to: 'if (pathname.length === 0) return null;',
    dir: 'apps/gateway',
    expect: /refuses an empty slug and anything not under the prefix/,
  },

  // ==========================================================================
  // 4. The route: guard order, 404 shape, no auth
  // ==========================================================================
  {
    label: 'the route: read the database before validating the slug',
    // The load-bearing ordering. A guard that ran after the lookup still 404s,
    // but the traversal string has already been handed to a query.
    file: 'apps/gateway/src/merchant-page.ts',
    from: `    const slug = merchantSlugFrom(new URL(c.req.url).pathname);
    if (slug === null) {
      return c.html(NOT_FOUND_HTML, 404, {
        'Cache-Control': \`public, max-age=\${MERCHANT_PAGE_TTL_SECONDS}\`,
      });
    }

    const merchant = await reader.findBySlug(slug);`,
    to: `    const slug = merchantSlugFrom(new URL(c.req.url).pathname);
    const merchant = await reader.findBySlug(slug ?? 'unvalidated');

    if (slug === null) {
      return c.html(NOT_FOUND_HTML, 404, {
        'Cache-Control': \`public, max-age=\${MERCHANT_PAGE_TTL_SECONDS}\`,
      });
    }`,
    dir: 'apps/gateway',
    expect: /never reached the database|never reads the database|without reaching the database/,
  },
  {
    label: 'the route: make the 200 response private instead of public',
    file: 'apps/gateway/src/merchant-page.ts',
    // Anchored on `renderMerchantPage(merchant), 200` specifically. The header
    // appears three times in this function — two 404s and the 200 — and a
    // mutation that replaced only the first occurrence would have changed a 404
    // that no assertion reads, then reported the guard as untested. It was
    // MISSED for exactly that reason before this anchor was made explicit.
    from: `    return c.html(renderMerchantPage(merchant), 200, {
      'Cache-Control': \`public, max-age=\${MERCHANT_PAGE_TTL_SECONDS}\`,`,
    to: `    return c.html(renderMerchantPage(merchant), 200, {
      'Cache-Control': \`private, max-age=\${MERCHANT_PAGE_TTL_SECONDS}\`,`,
    dir: 'apps/gateway',
    expect: /caches publicly/,
  },
  {
    label: 'the route: mount it under /v1 so it inherits the auth chain',
    file: 'apps/gateway/src/index.ts',
    from: "app.get(\n  '/p/*',",
    to: "app.get(\n  '/v1/p/*',",
    dir: 'apps/gateway',
    expect: /without a token|no authentication headers/,
  },

  // ==========================================================================
  // 5. The read: tenant scoping and the RLS ordering
  // ==========================================================================
  {
    label: 'the read: drop the business_id predicate on the program row',
    file: 'apps/gateway/src/merchant-store.ts',
    from: '.where(eq(loyaltyPrograms.businessId, tenant.id))',
    to: '.where(eq(loyaltyPrograms.id, tenant.id))',
    dir: 'apps/gateway',
    expect: /never reads another merchant|by the id the slug resolved to/,
  },
  {
    label: 'the read: look the tenant up by id instead of slug',
    file: 'apps/gateway/src/merchant-store.ts',
    from: '.where(eq(tenants.slug, slug))',
    to: '.where(eq(tenants.id, slug))',
    dir: 'apps/gateway',
    expect: /looks the tenant up by slug/,
  },
  {
    label: 'the read: move the RLS set_config after the program read',
    // Silent when wrong: with the policy enabled the page comes up empty and
    // reads as "this merchant configured nothing".
    file: 'apps/gateway/src/merchant-store.ts',
    from: `      await db.execute(setCurrentBusinessId(tenant.id));

      const [program] = await db
        .select({`,
    to: `      const [program] = await db
        .select({`,
    dir: 'apps/gateway',
    expect: /before reading the program/,
  },

  // ==========================================================================
  // 6. `homepageUri`: the slug is read, never derived
  // ==========================================================================
  {
    label: 'provision: build homepageUri from the merchant name instead of the slug',
    file: 'workers/wallet/src/provision.ts',
    from: 'uri: `${webBaseUrl}/p/${encodeURIComponent(branding.slug)}`',
    to: 'uri: `${webBaseUrl}/p/${encodeURIComponent(branding.name)}`',
    dir: 'workers/wallet',
    expect: /real slug|slug the tenant owns/,
  },
  {
    label: 'provision: accept a blank slug instead of refusing',
    file: 'workers/wallet/src/provision.ts',
    from: "if (branding.slug.trim() === '') {",
    to: "if (false) {",
    dir: 'workers/wallet',
    expect: /tenant_slug_missing|no slug/,
  },
  {
    label: 'provision: build the pass links from the gateway origin',
    file: 'workers/wallet/src/provision.ts',
    from: "links: [\n        { uri: `${customerWebBaseUrl}/profile`",
    to: "links: [\n        { uri: `${webBaseUrl}/profile`",
    dir: 'workers/wallet',
    expect: /from the customer web|configured customer-web var/,
  },
  {
    label: 'provision: point homepageUri at a route the gateway does not serve',
    file: 'workers/wallet/src/provision.ts',
    from: 'uri: `${webBaseUrl}/p/${encodeURIComponent(branding.slug)}`',
    to: 'uri: `${webBaseUrl}/program`',
    dir: 'workers/wallet',
    expect: /route the gateway source actually serves|per-merchant page/,
  },
  {
    label: 'wrangler: point WALLET_WEB_BASE_URL back at the customer web',
    file: 'workers/wallet/wrangler.jsonc',
    from: '"WALLET_WEB_BASE_URL": "https://media.juancode.dev"',
    to: '"WALLET_WEB_BASE_URL": "https://vyloop-customer-web.cl-jmunoz.workers.dev"',
    dir: 'workers/wallet',
    expect: /same host|gateway serves both routes/,
  },
  {
    label: 'wrangler: build the pass links from the gateway origin',
    file: 'workers/wallet/wrangler.jsonc',
    from: '"WALLET_CUSTOMER_WEB_BASE_URL": "https://vyloop-customer-web.cl-jmunoz.workers.dev"',
    to: '"WALLET_CUSTOMER_WEB_BASE_URL": "https://media.juancode.dev"',
    dir: 'workers/wallet',
    expect: /keeps the links host separate/,
  },
  {
    label: 'wrangler: add a var for a one-off debug',
    // The exact-list assertion's reason for existing. A subset assertion would
    // let this through and keep passing.
    file: 'workers/wallet/wrangler.jsonc',
    from: '"WALLET_CUSTOMER_WEB_BASE_URL": "https://vyloop-customer-web.cl-jmunoz.workers.dev"',
    to:
      '"WALLET_CUSTOMER_WEB_BASE_URL": "https://vyloop-customer-web.cl-jmunoz.workers.dev",\n    "WALLET_DEBUG": "true"',
    dir: 'workers/wallet',
    expect: /exactly the intended vars/,
  },
];

// ---------------------------------------------------------------------------
// Running one project's tests
// ---------------------------------------------------------------------------

/**
 * Run one vitest project and report whether it failed.
 *
 * `false` means the suite passed — which for a mutation is the bad outcome. The
 * exit code alone is not enough to distinguish "tests ran and passed" from
 * "vitest printed an error and exited non-zero", so the failure list is read out
 * of the output too, and a run with no recognisable test summary is treated as
 * inconclusive rather than as a pass.
 */
function testsFail(dir) {
  const project = join(ROOT, dir);
  try {
    const output = execFileSync('npx', ['vitest', 'run'], {
      cwd: project,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    });
    // A run that collected no tests is not a pass. It means the mutation broke
    // module loading so badly nothing could run, and reporting that as "green"
    // is the failure mode this script exists to rule out.
    const ran = /Tests\s+(\d+)\s+(passed|failed)/.exec(output);
    if (ran === null || Number(ran[1]) === 0) return 'inconclusive';
    if (ran[2] === 'failed') return true;
    return false;
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    // A non-zero exit with a real failure summary is the mutation being caught.
    if (/Tests\s+\d+\s+failed/.test(output)) return true;
    // Anything else — a module that would not load, a crashed runner — is not
    // evidence that a guard is load-bearing.
    return 'inconclusive';
  }
}

/** Content hash, so "did the write land" is asked of the bytes rather than of git. */
function digest(source) {
  return createHash('sha256').update(source).digest('hex');
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const results = [];
const touched = new Map();

console.log('Verifying that each guard is load-bearing.\n');
console.log('A guard counts only when removing it makes a test FAIL.\n');

for (const mutation of MUTATIONS) {
  const absolute = join(ROOT, mutation.file);
  const original = readFileSync(absolute, 'utf8');

  // Remember the pristine bytes for this file. The first mutation of a file
  // snapshots it; later ones for the same file reuse that snapshot rather than
  // snapshotting a mutation.
  if (!touched.has(mutation.file)) touched.set(mutation.file, original);
  const pristine = touched.get(mutation.file);

  if (!original.includes(mutation.from)) {
    results.push({ ...mutation, verdict: 'ANCHOR-MISSING' });
    console.log(`ANCHOR    ${mutation.label}  (not found in ${mutation.file})`);
    continue;
  }

  const mutated = original.replace(mutation.from, mutation.to);
  if (mutated === original) {
    results.push({ ...mutation, verdict: 'NO-OP' });
    console.log(`NO-OP     ${mutation.label}  (the replacement changed nothing)`);
    continue;
  }

  writeFileSync(absolute, mutated);

  // The check this whole file exists for, and the reason it is a byte comparison
  // rather than `git diff`: two of the files under test are new and untracked,
  // so `git diff` reports them clean whether or not they were written, and this
  // branch's own work is uncommitted, so every tracked file reads as dirty even
  // after a successful restore. Git cannot answer the question here at all.
  const onDisk = digest(readFileSync(absolute, 'utf8'));
  if (onDisk !== digest(mutated)) {
    results.push({ ...mutation, verdict: 'NO-OP' });
    console.log(`NO-OP     ${mutation.label}  (the write did not land)`);
    writeFileSync(absolute, original);
    continue;
  }

  const outcome = testsFail(mutation.dir);

  if (outcome === true) {
    results.push({ ...mutation, verdict: 'CAUGHT' });
    console.log(`CAUGHT    ${mutation.label}`);
  } else if (outcome === 'inconclusive') {
    results.push({ ...mutation, verdict: 'INCONCLUSIVE' });
    console.log(`INCONCL.  ${mutation.label}  (the suite did not run — result proves nothing)`);
  } else {
    results.push({ ...mutation, verdict: 'MISSED' });
    console.log(`MISSED    ${mutation.label}  (suite stayed green — guard is not load-bearing)`);
  }

  // Restore from the pristine snapshot, not from `original`: two mutations
  // targeting one file in sequence would otherwise compound.
  writeFileSync(absolute, pristine);
}

// ---------------------------------------------------------------------------
// Cleanup, and proof it happened
// ---------------------------------------------------------------------------

const notRestored = [...touched.entries()]
  .filter(([file, pristine]) => digest(readFileSync(join(ROOT, file), 'utf8')) !== digest(pristine))
  .map(([file]) => file);

console.log('');
console.log('Totals');
for (const verdict of ['CAUGHT', 'MISSED', 'NO-OP', 'ANCHOR-MISSING', 'INCONCLUSIVE']) {
  const count = results.filter((result) => result.verdict === verdict).length;
  if (count > 0) console.log(`  ${verdict.padEnd(14)} ${count}`);
}

console.log('');
console.log(
  notRestored.length === 0
    ? 'Every mutated file was restored byte for byte.'
    : `WARNING: these files were left modified: ${notRestored.join(', ')}`,
);

process.exit(results.some((result) => result.verdict !== 'CAUGHT') || notRestored.length > 0 ? 1 : 0);