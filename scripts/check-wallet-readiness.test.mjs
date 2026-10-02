// The readiness report is only worth having if it is honest. These tests pin the
// behaviour that makes it so: an unknown is never a pass, and the blocking gates
// come out in the order a request hits them.
//
// Development tool test: kept beside the script it covers, outside `src`, so it
// is neither linted nor typechecked as product code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildGates,
  formatReport,
  missingSecrets,
  observeProgramPage,
  PROGRAM_PAGE_PATH,
  PROGRAM_PAGE_TIMEOUT_MS,
  REQUIRED_SECRETS,
  resolveProgramPageOrigin,
  verdict,
} from './check-wallet-readiness.mjs';

const HEALTHY = {
  deployedSecrets: [...REQUIRED_SECRETS],
  canSeeSecrets: true,
  migrationApplied: true,
  canSeeDatabase: true,
  reviewStatus: 'approved',
  programCount: 1,
  demoMode: false,
  databaseLabel: 'neondb',
  gatewayReachable: true,
  canSeeProgramPage: true,
  programPageStatus: 200,
  programPageUrl: 'https://customer-web.invalid/program',
};

/**
 * A fetch that never touches the network. The status it reports is what the test
 * decides, so the program page gate is exercised without internet.
 */
function stubFetch(status) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (init?.signal?.aborted) throw new Error('aborted before dispatch');
    return { status };
  };
  impl.calls = calls;
  return impl;
}

/** A fetch that fails the way a machine with no egress does. */
function brokenFetch(error = new Error('getaddrinfo ENOTFOUND')) {
  return async () => {
    throw error;
  };
}

/**
 * A real slug, standing in for one read from `tenants`.
 *
 * `homepageUri` is `/p/{slug}`, so the check has to name a merchant to have
 * anything to fetch. It is passed in rather than written here, and `main` reads
 * it from the database — an invented slug would 404 and report a healthy
 * deployment as blocked.
 */
const SLUG = 'cafe-central';

const REPO_ROOT = process.cwd();
const REPO_SOURCES = {
  configPath: join(REPO_ROOT, 'workers/wallet/wrangler.jsonc'),
  sourcePath: join(REPO_ROOT, 'workers/wallet/src/helpers.ts'),
};

function firstBlocker(overrides) {
  return verdict(buildGates({ ...HEALTHY, ...overrides })).blocked[0]?.id;
}

describe('buildGates', () => {
  it('orders the gates the way a request hits them', () => {
    const ids = buildGates(HEALTHY).map((gate) => gate.id);
    // `program-page` sits right after `class` because it is the other half of the
    // same review: Google opens `homepageUri` while deciding the class.
    expect(ids).toEqual(['database', 'secrets', 'class', 'program-page', 'demo-mode', 'gateway']);
  });

  it('passes every gate when the deployment is genuinely ready', () => {
    expect(verdict(buildGates(HEALTHY)).blocked).toEqual([]);
  });

  it('names which secret is missing, not just that one is', () => {
    const gates = buildGates({ ...HEALTHY, deployedSecrets: ['MEMBER_CODE_PEPPER'] });
    const secrets = gates.find((gate) => gate.id === 'secrets');
    expect(secrets.pass).toBe(false);
    expect(secrets.blocked).toContain('GOOGLE_WALLET_PRIVATE_KEY');
    expect(secrets.blocked).toContain('GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL');
    expect(secrets.blocked).not.toContain('MEMBER_CODE_PEPPER');
  });

  it('blocks a class Google has not approved, whatever the state is called', () => {
    // "approved" is the only value that passes. A status the code does not
    // recognise must not be treated as a near-miss.
    for (const status of ['draft', 'pending', 'in_review', 'APPROVED', 'approved ']) {
      expect(firstBlocker({ reviewStatus: status })).toBe('class');
    }
  });

  it('blocks a missing class row separately from an unapproved one', () => {
    // Both block, but they are different problems with different fixes, so the
    // wording has to tell them apart.
    const missing = buildGates({ ...HEALTHY, programCount: 0, reviewStatus: null });
    const unapproved = buildGates({ ...HEALTHY, programCount: 1, reviewStatus: 'draft' });

    expect(missing.find((gate) => gate.id === 'class').pass).toBe(false);
    expect(missing.find((gate) => gate.id === 'class').blocked).toContain('no pass class row');
    expect(missing.find((gate) => gate.id === 'class').next).toContain('tenant_wallet_programs');

    expect(unapproved.find((gate) => gate.id === 'class').pass).toBe(false);
    expect(unapproved.find((gate) => gate.id === 'class').blocked).toContain('"draft"');
    expect(unapproved.find((gate) => gate.id === 'class').next).toContain('cannot be skipped');
  });

  it('reads the demo-mode switch as a boolean, not a config string', () => {
    // The gate reads the effective value, which is boolean: a row that is in demo
    // mode is a state, not a failure, so it must not be reported as a blocker.
    expect(buildGates(HEALTHY).find((g) => g.id === 'demo-mode').pass).toBe(true);
    expect(buildGates({ ...HEALTHY, demoMode: true }).find((g) => g.id === 'demo-mode').pass).toBe(false);
  });

  it('names the database it read, because the deployed worker uses another one', () => {
    // A report that reads dev-local and implies production is how a correctly
    // configured deployment reads as broken.
    expect(formatReport(buildGates(HEALTHY))).toContain('neondb');
  });
});

describe('verdict', () => {
  it('never treats an unobservable fact as readiness', () => {
    // The failure mode this exists to prevent: a check that could not run
    // reporting "ready" because nothing looked wrong.
    const { ready, unknown } = verdict(
      buildGates({ ...HEALTHY, canSeeSecrets: false, deployedSecrets: [] }),
    );
    expect(ready).toBeNull();
    expect(unknown.map((gate) => gate.id)).toEqual(['secrets']);
  });

  it('reports unknown when the class cannot be observed at all', () => {
    // Unreachable database means no status was read, so `reviewStatus` is null
    // rather than some value that happens to look fine. Both the table check and
    // the class check then rest on nothing and say so.
    const { ready, unknown } = verdict(
      buildGates({ ...HEALTHY, canSeeDatabase: false, reviewStatus: null, programCount: 0 }),
    );
    expect(ready).toBeNull();
    // The demo-mode switch is a column, so an unreadable database takes it with it.
    expect(unknown.map((gate) => gate.id)).toEqual(['database', 'class', 'demo-mode']);
  });

  it('does not report the class as blocked just because the database was unreachable', () => {
    // The distinction that matters: "Google has not approved it" and "I could not
    // find out" call for different actions, and conflating them sends someone to
    // re-apply a migration that is already there.
    const gates = buildGates({ ...HEALTHY, canSeeDatabase: false, reviewStatus: null, programCount: 0 });
    const cls = gates.find((gate) => gate.id === 'class');
    expect(cls.pass).toBeNull();
    expect(cls.pass).not.toBe(false);
  });

  it('is not ready when anything is blocked, even if other checks are unknown', () => {
    const { ready } = verdict(
      buildGates({ ...HEALTHY, canSeeSecrets: false, reviewStatus: 'draft' }),
    );
    expect(ready).toBe(false);
  });
});

describe('formatReport', () => {
  it('marks a passing gate PASS and a blocking one BLOCK', () => {
    const report = formatReport(buildGates({ ...HEALTHY, reviewStatus: 'draft', demoMode: true }));
    expect(report).toContain('[PASS] Wallet tables exist');
    expect(report).toContain('[BLOCK] Google approved the pass class');
    expect(report).toContain('NOT READY');
  });

  it('marks an unobservable gate as unknown rather than as a pass', () => {
    const report = formatReport(buildGates({ ...HEALTHY, canSeeSecrets: false }));
    expect(report).toContain('[????] Signing secrets on the deployed worker');
    expect(report).not.toContain('[PASS] Signing secrets on the deployed worker');
    expect(report).toContain('UNKNOWN');
  });

  it('never states a blocking fact for an unknown gate', () => {
    // The exact wording that misleads: an unreachable database reported as "the
    // tables are not there", and a secrets check that could not run reported as
    // a list of names that are missing.
    const report = formatReport(
      buildGates({
        ...HEALTHY,
        canSeeSecrets: false,
        canSeeDatabase: false,
        reviewStatus: null,
      }),
    );
    expect(report).toContain('could not be checked from here');
    expect(report).not.toContain('The wallet tables are not in this database');
    expect(report).not.toContain('no pass class row');
    expect(report).not.toContain('Missing:');
  });

  it('shows a next action for every blocker', () => {
    const report = formatReport(buildGates({ ...HEALTHY, deployedSecrets: [], demoMode: 'true' }));
    const blockers = report.split('\n').filter((line) => line.includes('next:'));
    expect(blockers.length).toBe(2);
  });
});

describe('missingSecrets', () => {
  it('reports only what is absent', () => {
    expect(missingSecrets(REQUIRED_SECRETS)).toEqual([]);
    expect(missingSecrets([])).toEqual(REQUIRED_SECRETS);
  });
});

describe('resolveProgramPageOrigin', () => {
  it('follows the deployed var instead of the source default', () => {
    // The case that matters: someone moved customer-web and updated the worker's
    // var. A check still pointed at the old host would be reporting on a URL
    // nothing deploys any more.
    expect(
      resolveProgramPageOrigin({
        override: null,
        configVar: 'https://new-customer.pages.dev',
        sourceDefault: 'https://old-customer.pages.dev',
      }),
    ).toBe('https://new-customer.pages.dev');
  });

  it('prefers the operator shell over the config', () => {
    // Same precedence the worker uses, so `WALLET_WEB_BASE_URL` in the shell is
    // the host under test.
    expect(
      resolveProgramPageOrigin({
        override: 'https://from-shell.pages.dev',
        configVar: 'https://from-config.pages.dev',
        sourceDefault: 'https://from-source.pages.dev',
      }),
    ).toBe('https://from-shell.pages.dev');
  });

  it('falls back to the source default when no var is set', () => {
    expect(
      resolveProgramPageOrigin({
        override: null,
        configVar: null,
        sourceDefault: 'https://from-source.pages.dev',
      }),
    ).toBe('https://from-source.pages.dev');
  });

  it('treats a blank var as absent, like the worker parser does', () => {
    // `parseWebBaseUrl` treats '' as "use the default", so a blank var that
    // pinned the check to '' would make it probe a relative URL.
    expect(
      resolveProgramPageOrigin({
        override: '   ',
        configVar: '',
        sourceDefault: 'https://from-source.pages.dev',
      }),
    ).toBe('https://from-source.pages.dev');
  });

  it('strips a trailing slash so the route is not /p//{slug}', () => {
    // `parseWebBaseUrl` strips it for the same reason: `/p//{slug}` is a different
    // URL to the route, and may be to Google.
    const origin = resolveProgramPageOrigin({
      override: null,
      configVar: 'https://from-config.pages.dev///',
      sourceDefault: null,
    });
    expect(`${origin}${PROGRAM_PAGE_PATH}/${SLUG}`).toBe(
      'https://from-config.pages.dev/p/cafe-central',
    );
  });

  it('returns null when no source could be read, rather than guessing a host', () => {
    expect(
      resolveProgramPageOrigin({ override: null, configVar: null, sourceDefault: null }),
    ).toBeNull();
  });
});

describe('observeProgramPage', () => {
  it('probes the per-merchant route with a real slug, not a bare prefix', async () => {
    // The gate moved with the class. `homepageUri` is `/p/{slug}`, so probing
    // `/p` on its own would read a 404 on a route that is working perfectly
    // and report the deployment as blocked. The slug has to come from a real
    // tenant, which is why this is passed in rather than invented here.
    const fetchImpl = stubFetch(200);

    const result = await observeProgramPage({
      ...REPO_SOURCES,
      override: 'https://gateway.example.dev',
      slug: 'cafe-central',
      fetchImpl,
    });

    expect(fetchImpl.calls[0].url).toBe('https://gateway.example.dev/p/cafe-central');
    expect(result.url).toBe('https://gateway.example.dev/p/cafe-central');
  });

  it('is unknown rather than probing a route with no slug', async () => {
    // There is no URL to check without a merchant, and inventing one would make
    // this gate decorative in exactly the way its other tests forbid: green
    // because nothing was asked.
    const fetchImpl = stubFetch(200);

    const result = await observeProgramPage({
      ...REPO_SOURCES,
      override: 'https://gateway.example.dev',
      slug: null,
      fetchImpl,
    });

    expect(result.known).toBe(false);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('reads the host out of the repo instead of restating it', async () => {
    // The live files, not fixtures: the check has to track
    // `DEFAULT_WALLET_WEB_BASE_URL` in the worker's own source, so moving
    // customer-web moves the check. Both sides of the assertion are read from
    // the repo, which is what makes it a contract rather than a snapshot.
    const fetchImpl = stubFetch(200);
    const source = readFileSync(REPO_SOURCES.sourcePath, 'utf8');
    const declared = /DEFAULT_WALLET_WEB_BASE_URL\s*=\s*'([^']+)'/.exec(source)?.[1];

    expect(declared).toBeTruthy();
    const result = await observeProgramPage({
      ...REPO_SOURCES,
      override: null,
      slug: 'cafe-central',
      fetchImpl,
    });
    expect(result.url).toBe(`${declared}${PROGRAM_PAGE_PATH}/${SLUG}`);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('keeps no copy of the host in the script itself', async () => {
    // The regression this whole file guards: a URL written into the check would
    // keep verifying a host the platform stopped deploying, and go green.
    const source = readFileSync(new URL('./check-wallet-readiness.mjs', import.meta.url), 'utf8');
    const declared = /DEFAULT_WALLET_WEB_BASE_URL\s*=\s*'([^']+)'/.exec(
      readFileSync(REPO_SOURCES.sourcePath, 'utf8'),
    )?.[1];

    expect(declared).toBeTruthy();
    expect(source).not.toContain(new URL(declared).host);
  });

  it('probes the route the class actually points at', async () => {
    const fetchImpl = stubFetch(200);
    await observeProgramPage({
      override: 'https://moved-gateway.example.dev',
      configPath: '/nonexistent/wrangler.jsonc',
      sourcePath: '/nonexistent/helpers.ts',
      slug: 'cafe-central',
      fetchImpl,
    });

    expect(fetchImpl.calls[0].url).toBe(
      `https://moved-gateway.example.dev${PROGRAM_PAGE_PATH}/${SLUG}`,
    );
  });

  it('reports a 404 as a fact, because a fact is what blocks', async () => {
    const result = await observeProgramPage({
      override: 'https://gone.pages.dev',
      configPath: '/nonexistent/wrangler.jsonc',
      sourcePath: '/nonexistent/helpers.ts',
      slug: 'cafe-central',
      fetchImpl: stubFetch(404),
    });

    expect(result).toMatchObject({ known: true, status: 404 });
  });

  it('reports a fetch that threw as unknown, never as a healthy page', async () => {
    // The load-bearing case. A CI box with no egress throws, and a check that
    // turns that into a pass is decorative: green because nothing answered.
    const result = await observeProgramPage({
      override: 'https://customer.pages.dev',
      configPath: '/nonexistent/wrangler.jsonc',
      sourcePath: '/nonexistent/helpers.ts',
      slug: 'cafe-central',
      fetchImpl: brokenFetch(),
    });

    expect(result.known).toBe(false);
    expect(result.status).toBeNull();
  });

  it('reports unknown when the host itself could not be determined', async () => {
    // Nothing readable anywhere: the gate must not invent a host, because a check
    // aimed at a URL it made up says nothing about the real one.
    const fetchImpl = stubFetch(200);
    const result = await observeProgramPage({
      override: null,
      configPath: '/nonexistent/wrangler.jsonc',
      sourcePath: '/nonexistent/helpers.ts',
      slug: 'cafe-central',
      fetchImpl,
    });

    expect(result.known).toBe(false);
    expect(result.url).toBeNull();
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('aborts instead of hanging, and the timeout is short', async () => {
    // A class waiting in review cannot sit behind a 30 second health check, so
    // the deadline is both bounded and actually wired to the request.
    expect(PROGRAM_PAGE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PROGRAM_PAGE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);

    let aborted = false;
    const hanging = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });

    const result = await observeProgramPage({
      override: 'https://slow.pages.dev',
      configPath: '/nonexistent/wrangler.jsonc',
      sourcePath: '/nonexistent/helpers.ts',
      slug: 'cafe-central',
      fetchImpl: hanging,
      timeoutMs: 20,
    });

    expect(aborted).toBe(true);
    expect(result.known).toBe(false);
  });
});

describe('program-page gate', () => {
  const gate = (observed) =>
    buildGates({ ...HEALTHY, ...observed }).find((g) => g.id === 'program-page');

  it('passes a 200, which is the only thing Google can review', () => {
    expect(gate({ programPageStatus: 200 }).pass).toBe(true);
  });

  it('fails a 404 and names the URL and the fix', () => {
    // The scenario: customer-web moved, the default points at nothing, and Google
    // rejects every new class. An operator has to get the host out of this gate.
    const page = gate({ programPageStatus: 404, programPageUrl: 'https://gone.pages.dev/program' });

    expect(page.pass).toBe(false);
    expect(page.blocked).toContain('404');
    expect(page.blocked).toContain('https://gone.pages.dev/program');
    expect(page.next).toContain('gateway');
    expect(page.next).toContain('WALLET_WEB_BASE_URL');
    // The host is one-way, and an operator reading this gate is exactly who
    // would otherwise reach for the var to point at staging.
    expect(page.next).toMatch(/back under review|no way to return it to draft/i);
  });

  it('fails any non-2xx, not just a 404', () => {
    // A 500 or a redirect is equally a page Google's reviewer cannot use, and
    // treating "it answered something" as healthy would be the same bug in
    // another status code.
    for (const status of [301, 403, 404, 500, 503]) {
      expect(gate({ programPageStatus: status }).pass).toBe(false);
    }
  });

  it('is unknown, not ok, when the page could not be reached at all', () => {
    // The exact failure the user cares about: no network must not read as a
    // working program page.
    const page = gate({ canSeeProgramPage: false, programPageStatus: null, programPageUrl: 'https://customer.pages.dev/program' });

    expect(page.pass).toBeNull();
    expect(page.pass).not.toBe(true);
    expect(page.pass).not.toBe(false);
  });

  it('is unknown, not ok, when the host could not be read', () => {
    // Not knowing which host to check is not the same as knowing the page works.
    const page = gate({ canSeeProgramPage: false, programPageStatus: null, programPageUrl: null });
    expect(page.pass).toBeNull();
  });

  it('does not make an unobservable page a readiness verdict', () => {
    const { ready, unknown } = verdict(
      buildGates({ ...HEALTHY, canSeeProgramPage: false, programPageStatus: null }),
    );

    expect(ready).toBeNull();
    expect(unknown.map((g) => g.id)).toEqual(['program-page']);
  });

  it('says nothing factual about the page when the check could not run', () => {
    // "The program page answers 404" from a box that never left the network sends
    // someone to redeploy a site that is fine.
    const report = formatReport(
      buildGates({ ...HEALTHY, canSeeProgramPage: false, programPageStatus: null }),
    );

    expect(report).toContain('[????] Public program page answers');
    expect(report).toContain('could not be checked from here');
    expect(report).not.toContain('[PASS] Public program page answers');
    expect(report).not.toContain('so Google');
  });

  it('shows a failing program page in the report with its URL', () => {
    const report = formatReport(
      buildGates({ ...HEALTHY, programPageStatus: 404, programPageUrl: 'https://gone.pages.dev/program' }),
    );

    expect(report).toContain('[BLOCK] Public program page answers');
    expect(report).toContain('https://gone.pages.dev/program');
    expect(report).toContain('NOT READY');
  });

  it('carries a thrown fetch all the way to the verdict as unknown', async () => {
    // End to end on purpose. The gate tests above hand it `known: false` directly,
    // so nothing there would notice `main` wiring `canSeeProgramPage: true`
    // unconditionally — which is precisely how a no-egress CI runner ends up with
    // a green light on a page nobody opened.
    const observed = await observeProgramPage({
      override: 'https://customer.pages.dev',
      configPath: '/nonexistent/wrangler.jsonc',
      sourcePath: '/nonexistent/helpers.ts',
      slug: 'cafe-central',
      fetchImpl: brokenFetch(),
    });

    const { ready, unknown } = verdict(
      buildGates({
        ...HEALTHY,
        canSeeProgramPage: observed.known,
        programPageStatus: observed.status,
        programPageUrl: observed.url,
      }),
    );

    expect(unknown.map((g) => g.id)).toEqual(['program-page']);
    expect(ready).toBeNull();
  });
});
