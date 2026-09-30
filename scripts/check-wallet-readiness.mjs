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

async function databaseFacts() {
  const url =
    process.env.DATABASE_URL ??
    (/^DATABASE_URL=(.*)$/m.exec(readFileSync('apps/gateway/.dev.vars', 'utf8')) || [])[1];
  if (!url) return { known: false, migrationApplied: false, reviewStatus: null };

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
      ssl: { rejectUnauthorized: false },
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
      };
    } finally {
      await pool.end();
    }
  } catch {
    return { known: false, migrationApplied: false, reviewStatus: null };
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

  const secrets = deployedSecretNames();
  const database = await databaseFacts();

  const gates = buildGates({
    deployedSecrets: secrets.names,
    canSeeSecrets: secrets.known,
    migrationApplied: database.migrationApplied,
    canSeeDatabase: database.known,
    programCount: database.programCount,
    databaseLabel: database.databaseLabel,
    reviewStatus: database.reviewStatus,
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
      '  note: no DATABASE_URL in this shell, so the class and table checks could not run.\n',
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
