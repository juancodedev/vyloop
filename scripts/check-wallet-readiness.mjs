// Wallet readiness report.
//
// Answers one question: can this deployment mint a pass right now, and if not,
// what exactly is stopping it? Every gate the pass path enforces appears here in
// the order the request hits them, with the reason and the next action.
//
// Read-only. It opens no listener, mutates nothing, and reports "unknown" rather
// than guessing when it cannot see a fact — a check that silently passes because
// it could not run is worse than no check.
//
// Not part of the shipped test suite: a development tool kept out of `src` so it
// is neither linted nor typechecked as product code.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { assertVerifiedTls, isProductionHost } from './lib/database-url.mjs';

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

/** Secret names the pass path reads. Missing any of them stops issuance. */
export const REQUIRED_SECRETS = [
  'GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_WALLET_PRIVATE_KEY',
  'MEMBER_CODE_PEPPER',
];

export const PASS_BLOCKED = 'blocked';
export const PASS_OK = 'ok';
export const PASS_UNKNOWN = 'unknown';

/**
 * The route prefix a class's `homepageUri` points at, as `provision.ts` builds it.
 *
 * Was `/program`. It is now `/p/{slug}` — the per-merchant page the gateway
 * renders server-side from `loyalty_programs.promo_copy` — because a class review
 * is judged on the bytes Google's reviewer receives, and a `next-on-pages` static
 * export serves 18 characters of text no matter how good the page behind it is.
 *
 * A prefix, not a complete path, and that is the whole reason the slug is
 * threaded in from the database: probing `/p` alone would read a 404 on a route
 * that is working perfectly and report the deployment as blocked. See
 * `observeProgramPage`.
 */
export const PROGRAM_PAGE_PATH = '/p';

/**
 * How long the program page gets to answer.
 *
 * Short on purpose. This gate is read by someone waiting on a class in Google's
 * review, and a health check that takes 30 seconds to fail is one that gets
 * skipped. The gateway check can afford its 10s because nothing is waiting on
 * that one; this one cannot.
 */
export const PROGRAM_PAGE_TIMEOUT_MS = 5_000;

/**
 * Turns raw observations into gates.
 *
 * Pure: no I/O, no environment access, so the ordering and the wording are
 * testable without a database, a Cloudflare account, or a browser.
 *
 * @param observed.deployedSecrets  secret names on the deployed wallet worker
 * @param observed.reviewStatus     `tenant_wallet_programs.review_status`, or null
 * @param observed.demoMode         value of `WALLET_DEMO_MODE` in the config
 * @param observed.migrationApplied whether the wallet tables exist
 * @param observed.gatewayReachable whether the gateway answers at all
 * @param observed.canSeeSecrets    whether the secrets check could run
 * @param observed.canSeeDatabase   whether the database check could run
 */
export function buildGates(observed) {
  const gates = [];

  // A gate that could not be observed is unknown, never a pass and never a
  // block. `pass` is forced to null whenever `known` is false, so a missing
  // observation cannot read as either verdict — reporting "the migration is
  // missing" when the truth is "I could not look" is worse than saying nothing.
  const gate = (id, title, known, passes, blocked, next, extra = {}) => ({
    id,
    title,
    pass: known ? passes : null,
    known,
    blocked,
    next,
    ...extra,
  });

  // The order below is the order a request hits them.
  gates.push(
    gate(
      'database',
      'Wallet tables exist',
      observed.canSeeDatabase,
      observed.migrationApplied,
      'The wallet tables are not in this database.',
      'Apply packages/db/drizzle/0004_chubby_crystal.sql to this database.',
      { databaseLabel: observed.databaseLabel },
    ),
  );

  gates.push(
    gate(
      'secrets',
      'Signing secrets on the deployed worker',
      observed.canSeeSecrets,
      REQUIRED_SECRETS.every((name) => observed.deployedSecrets.includes(name)),
      `Missing: ${missingSecrets(observed.deployedSecrets).join(', ')}`,
      'npx wrangler secret put <NAME>   (run from workers/wallet)',
    ),
  );

  gates.push(
    gate(
      'class',
      'Google approved the pass class',
      // A readable database with no row is a definite fact — the business has no
      // class provisioned — so it blocks. Only an unreadable database is unknown.
      // Collapsing both into "no status" would report a missing class as
      // unobservable, which reads as "nothing to do" and is the opposite of true.
      observed.canSeeDatabase,
      observed.programCount > 0 && observed.reviewStatus === 'approved',
      observed.programCount === 0
        ? 'This business has no pass class row, so no pass can exist yet.'
        : `Class review status is "${observed.reviewStatus}".`,
      observed.programCount === 0
        ? 'Create the tenant_wallet_programs row for this business (issuer id and derived class id).'
        : 'Google reviews the class. It cannot be skipped, and no code path here can override it.',
    ),
  );

  // The other half of the same review. Google opens `homepageUri` while deciding
  // the class, so a page that does not answer does not fail a deploy — it fails
  // the review, silently, for every class created afterwards. docs/11 records it
  // as the most common rejection reason, which is why it is a gate here at all.
  gates.push(
    gate(
      'program-page',
      'Public program page answers',
      observed.canSeeProgramPage,
      // Only a 2xx is a page a reviewer can open. A redirect, a 404 and a 500 are
      // all a rejected class, so "it answered something" is not good enough here
      // the way it is for the gateway — there, any answer proves the route exists.
      typeof observed.programPageStatus === 'number' &&
        observed.programPageStatus >= 200 &&
        observed.programPageStatus < 300,
      `The program page a class points at answers ${observed.programPageStatus}` +
        `${observed.programPageUrl ? ` (${observed.programPageUrl})` : ''}, so Google's reviewer opens no page.`,
      'Redeploy apps/gateway, or point WALLET_WEB_BASE_URL at a host where /p/{slug} resolves. Google opens this URL during class review and rejects the class on a non-2xx — docs/11 records it as the most common rejection reason. Note that moving the host after a class is approved puts that class back under review with no way to return it to draft, so treat a change here as a product decision.',
      { programPageUrl: observed.programPageUrl ?? null },
    ),
  );

  gates.push(
    gate(
      'demo-mode',
      'Tenant declares publishing access',
      observed.canSeeDatabase,
      observed.demoMode === false,
      // Not a blocker. In demo mode a `draft` class is usable and a pass can be
      // minted — Google limits delivery to the issuer's test accounts, which is
      // the point. It only means the pass will not reach a real customer.
      //
      // This gate used to read the opposite way, because a `draft` class was an
      // unconditional refusal. That changed, and a report still calling demo mode
      // a blocker would be reporting a state as a failure.
      observed.programCount === 0
        ? 'There is no tenant row, so there is no switch to read.'
        : `The tenant is in demo mode, so passes only reach the issuer's test accounts. This is correct until Google grants publishing access.`,
      'Set demo_mode to false on the tenant row once Google has granted publishing access, and set WALLET_DEMO_MODE to "false" in wrangler.jsonc.',
    ),
  );

  gates.push(
    gate(
      'gateway',
      'Gateway answers',
      typeof observed.gatewayReachable === 'boolean',
      observed.gatewayReachable,
      'The gateway did not answer.',
      'Check the deploy status of apps/gateway.',
    ),
  );

  return gates;
}

export function missingSecrets(deployed) {
  return REQUIRED_SECRETS.filter((name) => !deployed.includes(name));
}

/**
 * The one line that matters: can a pass be minted, yes or no.
 *
 * An unknown is never counted as a pass. A gate that could not be checked means
 * the answer is not "ready", it means nobody knows yet.
 */
export function verdict(gates) {
  const blocked = gates.filter((gate) => gate.pass === false);
  if (blocked.length === 0) {
    return { ready: null, blocked, unknown: gates.filter((g) => g.pass === null) };
  }
  return { ready: false, blocked, unknown: gates.filter((g) => g.pass === null) };
}

export function formatReport(gates) {
  const { ready, blocked, unknown } = verdict(gates);
  // Read from the gates rather than a second argument: the label is observation
  // data, and threading it separately would be one more thing a caller forgets.
  const databaseGate = gates.find((gate) => gate.id === 'database');
  const observed = databaseGate ? databaseGate : {};
  const lines = [];

  lines.push('');
  lines.push('  Vyloop wallet readiness');
  // Which database this is about, stated before anything else. The report falls
  // back to `apps/gateway/.dev.vars`, and the deployed worker uses a different
  // `DATABASE_URL` entirely — a report that read one and implied the other is
  // how a correctly configured production reads as broken.
  lines.push(
    `  database: ${observed.databaseLabel ?? 'unknown'}` +
      (observed.databaseLabel && observed.deployedDatabaseLabel
        ? observed.databaseLabel === observed.deployedDatabaseLabel
          ? '  (matches the deployed worker)'
          : '  *** DIFFERS FROM THE DEPLOYED WORKER ***'
        : ''),
  );
  lines.push('  ' + '-'.repeat(52));

  for (const gate of gates) {
    const mark = gate.pass === true ? 'PASS' : gate.pass === false ? 'BLOCK' : '????';
    lines.push(`  [${mark}] ${gate.title}`);

    if (gate.pass === false) {
      // Only a block states a fact about the deployment.
      lines.push(`         ${gate.blocked}`);
      lines.push(`         next: ${gate.next}`);
    } else if (gate.pass === null) {
      // An unknown must not borrow the blocking wording. "The tables are not
      // there" and "I could not look" are different claims, and only the first
      // one is a fact. Printing the second as the first is how someone ends up
      // re-applying a migration that was there all along.
      lines.push('         could not be checked from here.');
    }
  }

  lines.push('  ' + '-'.repeat(52));
  if (ready === null) {
    lines.push(
      `  UNKNOWN — ${unknown.length} check(s) could not run, so readiness is not established.`,
    );
  } else {
    lines.push(`  NOT READY — ${blocked.length} of ${gates.length} gates are blocking.`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Observation — the only part that touches the outside world
// ---------------------------------------------------------------------------

function readConfigVar(name, configPath) {
  const config = readFileSync(configPath, 'utf8');
  const match = new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(config);
  return match ? match[1] : null;
}

/** The same read, but a file that is not there is `null` rather than a crash. */
function tryReadConfigVar(name, configPath) {
  try {
    return readConfigVar(name, configPath);
  } catch {
    return null;
  }
}

/**
 * `DEFAULT_WALLET_WEB_BASE_URL` read out of the worker's own source.
 *
 * Parsed from the file rather than restated here on purpose. This is the whole
 * reason the check can be trusted: the day customer-web moves and the default
 * changes, the check follows it, because there is no second copy to forget.
 */
function sourceDefaultWebBaseUrl(sourcePath) {
  try {
    const source = readFileSync(sourcePath, 'utf8');
    return /DEFAULT_WALLET_WEB_BASE_URL\s*=\s*'([^']+)'/.exec(source)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Which origin the program page check has to hit.
 *
 * Precedence mirrors what the worker actually runs with: the operator's shell,
 * then the var in the deployed wrangler config, then the source default. The
 * wrangler var is consulted before the constant deliberately — that var is what
 * production deploys, so preferring the constant would verify a URL nobody
 * serves while the real one is broken.
 *
 * Blank counts as absent because `parseWebBaseUrl` treats `''` as "use the
 * default"; a blank var must not pin the check to a relative URL.
 *
 * Returns null when nothing could be read, which the gate reports as unknown
 * rather than falling back to a guess.
 */
export function resolveProgramPageOrigin({ override, configVar, sourceDefault }) {
  const chosen = [override, configVar, sourceDefault].find(
    (value) => typeof value === 'string' && value.trim() !== '',
  );
  if (chosen === undefined) return null;

  // Same trailing-slash treatment as `parseWebBaseUrl`, because the value is
  // concatenated with `/program` in exactly the same way and `//program` is a
  // different URL to the route.
  return chosen.trim().replace(/\/+$/, '');
}

/**
 * Ask the program page for a status code.
 *
 * Two outcomes, one rule: a response is a fact and is reported as one; no
 * response at all — DNS, TLS, timeout, or a CI runner with no egress — means
 * nobody knows, and comes back `known: false` so the gate reads unknown. Turning
 * a thrown fetch into a pass is how this check becomes decorative: green because
 * nothing answered.
 */
export async function probeProgramPage(
  url,
  { fetchImpl = fetch, timeoutMs = PROGRAM_PAGE_TIMEOUT_MS } = {},
) {
  try {
    const response = await fetchImpl(url, {
      // Google follows redirects before deciding, so following them here measures
      // the page a reviewer ends up on rather than the first hop.
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { known: true, status: response.status, url };
  } catch {
    return { known: false, status: null, url };
  }
}

/**
 * The public program page, as a fact.
 *
 * @param slug `tenants.slug` — the last segment of the route. Required, because
 *   `homepageUri` is `/p/{slug}` and there is no page without one. Read by
 *   `main` from the database rather than invented here: a made-up slug 404s, and
 *   a gate that reports a healthy deployment as blocked is one nobody reads.
 *   A deployment with no tenant yet has nothing to check, which is `unknown`
 *   rather than a pass.
 *
 * Read-only: one GET on a public route, nothing opened and nothing mutated. The
 * `fetch` implementation is injected so the tests can drive 404, no-network and
 * timeout without ever leaving the machine.
 */
export async function observeProgramPage({
  override,
  configPath,
  sourcePath,
  slug,
  fetchImpl = fetch,
  timeoutMs = PROGRAM_PAGE_TIMEOUT_MS,
}) {
  const origin = resolveProgramPageOrigin({
    override,
    configVar: tryReadConfigVar('WALLET_WEB_BASE_URL', configPath),
    sourceDefault: sourceDefaultWebBaseUrl(sourcePath),
  });

  // No host is a fact about this check, not about the page: do not invent one.
  if (origin === null) return { known: false, status: null, url: null };

  // A blank slug is no different from an absent one. `parseWebBaseUrl` treats ''
  // as "use the default", so this has to treat it the same rather than fetching
  // `/p` and reporting the 404 as a broken page.
  if (typeof slug !== 'string' || slug.trim() === '') {
    return { known: false, status: null, url: null };
  }

  return probeProgramPage(`${origin}${PROGRAM_PAGE_PATH}/${slug.trim()}`, {
    fetchImpl,
    timeoutMs,
  });
}

function deployedSecretNames() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return { known: false, names: [] };

  try {
    const raw = execFileSync(
      'npx',
      ['--yes', 'wrangler', 'secret', 'list', '--config', 'workers/wallet/wrangler.jsonc'],
      { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const names = [...raw.matchAll(/^\s*[\w]+\s+[A-Z_][A-Z0-9_]*\s*$/gm)]
      .map((line) => line[0].trim().split(/\s+/).pop())
      .filter((name) => name && name.includes('_'));
    return { known: true, names };
  } catch {
    return { known: false, names: [] };
  }
}

/**
 * `DATABASE_URL` from the local dev file, or `null` when there is no local dev file.
 *
 * The third read in this file that could crash on a missing file, and the only one
 * that did. `.dev.vars` is gitignored — correctly, it holds secrets — so on CI it
 * does not exist, and `process.env.DATABASE_URL ?? readFileSync(...)` fell straight
 * into the read and threw `ENOENT` on every deploy.
 *
 * The consequence was worse than a failed step: `main` exits non-zero on a `BLOCK`,
 * so the throw made this report exit 1 while it had printed nothing, and the
 * `continue-on-error: true` on the workflow step swallowed the stack trace instead
 * of a report. The step had never once produced a report in CI.
 *
 * `null` is the honest answer here, and the caller already handles it: this script's
 * contract is to report `unknown` rather than guess when it cannot see a fact. The
 * same shape as `tryReadConfigVar` and `sourceDefaultWebBaseUrl` above, and it takes
 * the path as an argument for the same reason they do: a helper that can only be
 * called with one path cannot be tested for the case that matters.
 */
export function readDevVarsDatabaseUrl(devVarsPath) {
  try {
    return /^DATABASE_URL=(.*)$/m.exec(readFileSync(devVarsPath, 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

async function databaseFacts() {
  const url =
    process.env.DATABASE_URL ?? readDevVarsDatabaseUrl('apps/gateway/.dev.vars');
  if (!url) {
    return {
      known: false,
      migrationApplied: false,
      reviewStatus: null,
      slug: null,
      reason: 'no DATABASE_URL in this shell',
    };
  }

  // A local Neon branch does not get a CA setup here, so the report keeps the
  // unverified pool below. The production host is the exception: it holds real
  // passes, and "it connected" must not mean "it connected to whatever answered".
  const production = isProductionHost(url);
  if (production) {
    try {
      assertVerifiedTls(url);
    } catch (error) {
      return {
        known: false,
        migrationApplied: false,
        reviewStatus: null,
        slug: null,
        reason: error.message,
      };
    }
  }

  try {
    // `pg` is a dependency of packages/db, not of the repository root, so a
    // plain dynamic import from a script at the top level does not resolve it.
    // Requiring it relative to that package finds the same copy the workers use,
    // rather than a second one.
    const require = createRequire(join(process.cwd(), 'packages/db/package.json'));
    const { Pool } = require('pg');

    const pool = new Pool({
      connectionString: url,
      max: 1,
      ...(production ? {} : { ssl: { rejectUnauthorized: false } }),
      connectionTimeoutMillis: 10_000,
    });

    try {
      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_name IN ('tenant_wallet_programs','customer_wallet_passes')`,
      );
      const migrationApplied = tables.rowCount === 2;

      // Which database this is, read on its own. The program table can be empty —
      // which is a finding, not a failure — so the identity cannot come from that
      // read, and a report that silently described some other database as the
      // deployed one would be worse than one that said nothing.
      const identity = await pool
        .query('SELECT current_database() AS db')
        .catch(() => ({ rows: [] }));

      // Read the review status, and how many program rows there are. With no row
      // at all the business has no class provisioned, which is a different
      // problem from having one that Google has not approved yet.
      const programs = await pool
        .query(`SELECT review_status, demo_mode, current_database() AS db FROM tenant_wallet_programs`)
        .catch(() => ({ rows: [] }));

      // A slug to probe `/p/{slug}` with. Read from `tenants` rather than
      // invented: the program page is per-merchant, so there is no slug-free
      // URL to check, and a made-up one would 404 and report a healthy
      // deployment as blocked. `tenant_wallet_programs` does not carry it.
      //
      // `LIMIT 1` with no ordering, because any tenant's page proves the route
      // works — this gate asks "does the route answer", not "does this merchant
      // have one". Absent or blank is `null`, which reaches the page check as
      // `unknown` rather than as a pass.
      const slugRow = await pool
        .query(`SELECT slug FROM tenants WHERE slug IS NOT NULL AND slug <> '' LIMIT 1`)
        .catch(() => ({ rows: [] }));

      const statuses = programs.rows.map((row) => row.review_status);
      return {
        known: true,
        migrationApplied,
        reviewStatus: statuses.length === 1 ? statuses[0] : null,
        // The per-tenant switch, which is the half an operator can change. Absent
        // means demo mode, matching how the gate reads it.
        demoMode: programs.rows.length === 1 ? programs.rows[0].demo_mode !== false : null,
        databaseLabel: identity.rows[0]?.db ?? null,
        programCount: statuses.length,
        slug: typeof slugRow.rows[0]?.slug === 'string' ? slugRow.rows[0].slug : null,
      };
    } finally {
      await pool.end();
    }
  } catch {
    return { known: false, migrationApplied: false, reviewStatus: null, slug: null };
  }
}

async function gatewayReachable(url) {
  try {
    const response = await fetch(`${url}/v1/wallet/status`, {
      signal: AbortSignal.timeout(10_000),
    });
    // Any answer proves the route is there. 401 is the expected one: the route
    // exists and refuses an unauthenticated caller, which is the healthy state.
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const gatewayUrl =
    process.env.NEXT_PUBLIC_API_URL ?? 'https://gateway.cl-jmunoz.workers.dev';
  const configPath = join(process.cwd(), 'workers/wallet/wrangler.jsonc');
  const helpersPath = join(process.cwd(), 'workers/wallet/src/helpers.ts');

  const secrets = deployedSecretNames();
  const database = await databaseFacts();
  const programPage = await observeProgramPage({
    override: process.env.WALLET_WEB_BASE_URL,
    configPath,
    sourcePath: helpersPath,
    // Read, never invented: the route is per-merchant, so there is no slug-free
    // URL to probe. A deployment with no tenant reports `unknown` here rather
    // than a pass — see `observeProgramPage`.
    slug: database.slug,
  });

  const gates = buildGates({
    deployedSecrets: secrets.names,
    canSeeSecrets: secrets.known,
    migrationApplied: database.migrationApplied,
    canSeeDatabase: database.known,
    programCount: database.programCount,
    databaseLabel: database.databaseLabel,
    reviewStatus: database.reviewStatus,
    canSeeProgramPage: programPage.known,
    programPageStatus: programPage.status,
    programPageUrl: programPage.url,
    // Effective demo mode is `env || row`, the same combination the gate uses.
    // Reading only the config would report the deployment ceiling and hide the
    // half an operator can change.
    demoMode:
      readConfigVar('WALLET_DEMO_MODE', configPath) === 'false' &&
      database.known &&
      database.programCount > 0 &&
      database.demoMode === false,
    gatewayReachable: await gatewayReachable(gatewayUrl),
  });

  process.stdout.write(formatReport(gates));

  if (!secrets.known) {
    process.stdout.write(
      '  note: no CLOUDFLARE_API_TOKEN in this shell, so the secrets check could not run.\n' +
        '        It is reported as unknown, never as passing.\n',
    );
  }
  if (!database.known) {
    process.stdout.write(
      `  note: ${database.reason ?? 'no DATABASE_URL in this shell'}, so the class and table checks could not run.\n`,
    );
  }
  if (!programPage.known) {
    // The URL is named even when the check could not run, because "I could not
    // check it" is only actionable if it says which host it was trying.
    process.stdout.write(
      `  note: the program page check could not run against ` +
        `${programPage.url ?? 'an undetermined host'}, so it is reported as unknown.\n` +
        '        A machine with no network reaches this too — that is not a working page.\n',
    );
  }
  process.stdout.write('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('readiness report failed:', error);
    process.exit(1);
  });
}
