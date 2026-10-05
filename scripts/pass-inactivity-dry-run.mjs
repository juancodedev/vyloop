// Pass-inactivity dry run.
//
// Answers one question, and it is the question you have to be able to answer
// before you run anything: **if the pass-inactivity rule ran right now, how many
// customers' Google Wallet passes would it deactivate, and which ones?**
//
// Read-only, and read-only by construction rather than by flag: this file
// imports `planInactivityDeactivation`, which takes no `GoogleWalletClient` in
// its dependencies at all, so there is no code path here that can reach Google.
// It also never writes to the database — the plan is one `SELECT` per configured
// tenant. A dry run that could write would be a dry run that writes the day
// somebody extends it.
//
// ## Why this is the easiest invocation, not just an available one
//
// `tenant_wallet_programs.pass_inactivity_months` is nullable with no default, so
// the rule is off for every tenant until a human writes a number into it. The
// first run of an opted-in rule is a mass state change on real customers' phones,
// and the only mitigation this system has is knowing the count beforehand. So the
// count has to be reachable in one command, without Google credentials, without a
// service binding, and without a deployment.
//
// ## Not part of the shipped test suite
//
// An operational tool kept out of `src` so it is neither linted nor typechecked
// as product code, the same convention `check-wallet-readiness.mjs` and
// `check-migration-drift.mjs` follow. Its argument parsing and report rendering
// are pure and are covered by `pass-inactivity-dry-run.test.mjs`.

import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export const USAGE = `Usage: pass-inactivity-dry-run [--tenant <uuid>] [--json] [--help]

Reports how many Google Wallet passes the pass-inactivity rule would deactivate
right now, per tenant, and changes nothing.

  --tenant <uuid>   Only this tenant. Omit to walk every tenant with a window
                    configured. Not a filter applied after the fact: the tenant is
                    what the candidate query is scoped by, so this cannot widen
                    into another merchant's rows.
  --json            Emit the raw plan as JSON instead of the text report.
  --help            This text.

Requires DATABASE_URL. Requires no Google credentials — the plan never calls
Google.

A tenant with pass_inactivity_months NULL, or 0, is reported as "not configured"
and contributes nothing. That is the expected state for a tenant that has not
opted in.`;

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_NO_DATABASE_URL = 3;

/**
 * Parse argv into options, or into a reason it could not.
 *
 * Returns a discriminated result rather than throwing or exiting, so the parsing
 * is testable without a process and so the caller decides what a bad flag does.
 *
 * `--tenant` takes the tenant's uuid because that is what the candidate query is
 * scoped by. It is not a post-hoc filter over a global candidate list, which is
 * the shape that produces a cross-tenant leak: with the filter applied afterwards
 * the data for every tenant is already in memory.
 *
 * There is deliberately **no `--apply`**. The write path is not reachable from
 * this script, and adding a flag that turns a read-only tool into a writer is the
 * change that should require writing a new tool rather than editing this one.
 */
export function parseArgs(argv) {
  const options = { tenantId: null, json: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--tenant': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          return { ok: false, reason: '--tenant needs a tenant id after it.' };
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
          return {
            ok: false,
            reason:
              `"${value}" is not a tenant id. It has to be a uuid: this value is bound as a ` +
              '`::uuid` in the query that scopes the whole rule, so a typo must fail here ' +
              'rather than be cast to NULL and quietly match no rows.',
          };
        }
        options.tenantId = value;
        i += 1;
        break;
      }
      default:
        return {
          ok: false,
          reason: `Unknown argument "${arg}". This script takes no flag that writes; see --help.`,
        };
    }
  }

  return { ok: true, options };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * Render the plan as the text an operator reads before deciding.
 *
 * ## Why the number is printed twice
 *
 * The per-tenant candidate list can be long, and an operator scrolling past it
 * should not have to count rows to answer "how many". So the count is repeated in
 * the tenant's own header and again in the total — and both come from
 * `plan.totalCandidates` / `plan.tenants[].candidates.length`, which is what the
 * write path will use, not a recount of the printed lines. A report whose header
 * number disagrees with its own body is the thing that makes a dry run worthless.
 *
 * ## Why truncation is called out loudly
 *
 * `truncated` means the per-run bound cut this tenant short, so the number shown
 * is a floor and the real figure is larger. Printing it as if it were the total
 * would be the one way this report could cause a decision it should not support.
 */
export function renderPlan(plan, options = {}) {
  const lines = [];
  const scopedTo = options.tenantId === null ? 'every tenant' : options.tenantId;

  lines.push('Pass inactivity dry run — nothing was written and Google was not called.');
  lines.push(`Scope: ${scopedTo}`);
  lines.push('');

  if (plan.tenantsConsidered === 0) {
    lines.push('No tenant with a Google Wallet program row was found.');
    return lines.join('\n');
  }

  if (plan.tenantsConfigured === 0) {
    lines.push(
      `No tenant has this rule enabled. ${plan.tenantsConsidered} tenant(s) were considered and ` +
        'every one of them has pass_inactivity_months NULL, 0, or no program row.',
    );
    lines.push('');
    lines.push(
      'To enable it for a tenant, set its window in months — and read ' +
        'packages/db/drizzle/0009_worried_onslaught.sql first, because it explains why ' +
        'loyalty_programs.points_expiry_days is not the column this uses.',
    );
    return lines.join('\n');
  }

  for (const tenant of plan.tenants) {
    lines.push(
      `Tenant ${tenant.tenantId} — window ${tenant.months} month(s), ` +
        `cutoff ${tenant.cutoff.toISOString()} — ${tenant.candidates.length} pass(es) would be ` +
        `deactivated${tenant.truncated ? ' (TRUNCATED: this is a floor, not the total)' : ''}`,
    );

    for (const candidate of tenant.candidates) {
      // The last activity is printed because "why is this customer in this list"
      // is the question an operator has about every single row, and answering it
      // requires a query they should not have to write.
      const activity =
        candidate.lastActivityAt === null
          ? 'never transacted (clocked from enrolment)'
          : `last activity ${candidate.lastActivityAt.toISOString()}`;
      lines.push(`    ${candidate.customerId}  ${candidate.objectId}  ${activity}`);
    }
    lines.push('');
  }

  lines.push(
    `Total: ${plan.totalCandidates} pass(es) across ${plan.tenantsConfigured} configured tenant(s).`,
  );
  lines.push(
    `${plan.tenantsConsidered} tenant(s) considered, ${plan.tenantsDisabled} not configured ` +
      '(pass_inactivity_months is NULL or 0).',
  );
  if (plan.tenantsTruncated > 0) {
    lines.push(
      `${plan.tenantsTruncated} tenant(s) hit the per-run candidate bound, so their count is a ` +
        'lower bound. Raise the bound or run again after the first batch is applied.',
    );
  }

  lines.push('');
  lines.push(
    'To act on this, the automation worker calls the wallet worker\'s ' +
      '`deactivateInactivePasses({ dryRun: false })` from its daily cron. There is deliberately ' +
      'no --apply here: this script cannot write.',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Load the wallet worker's plan over a TypeScript loader.
 *
 * `tsx` rather than a hand-rolled reimplementation of the query. The whole value
 * of this script is that it prints the number the *write path* will use, and a
 * second copy of the candidate SQL could disagree with it — which would make the
 * dry run report a count that is not the count, and a dry run that lies is worse
 * than no dry run.
 */
async function loadPlan(options) {
  const require = createRequire(import.meta.url);

  let tsx;
  try {
    tsx = require.resolve('tsx/esm/api');
  } catch {
    throw new Error(
      "Could not load `tsx`, which is needed to import the wallet worker's TypeScript. Run " +
        'this through the db workspace, which carries it: ' +
        '`pnpm --filter @vyloop/db exec tsx ../../scripts/pass-inactivity-dry-run.mjs`.',
    );
  }

  const { register } = await import(tsx);
  const unregister = register();

  try {
    const { createDb } = await import('@vyloop/db');
    const { createDrizzleWalletStore } = await import('../workers/wallet/src/drizzle-store.ts');
    const { planInactivityDeactivation } = await import(
      '../workers/wallet/src/inactivity.ts'
    );

    const db = createDb(process.env.DATABASE_URL);
    const store = createDrizzleWalletStore(db);

    const full = await planInactivityDeactivation({ store });
    return options.tenantId === null ? full : narrowPlanTo(full, options.tenantId);
  } finally {
    unregister();
  }
}

/**
 * The same plan, reported for one tenant.
 *
 * Narrowed from the full plan rather than from a second query, so there is still
 * exactly **one** candidate query in the codebase. `listProgramTenants` is
 * keyset-paginated and reads a handful of rows, so walking it and dropping the
 * rest costs nothing — whereas a second query scoped to one tenant would be a
 * second definition of "who is inactive" that could disagree with the write path.
 *
 * Narrowed on **every** counter, so a report cannot show one tenant's candidates
 * beside another tenant's totals. That mismatch is the failure this function
 * exists to make impossible.
 */
export function narrowPlanTo(plan, tenantId) {
  const tenants = plan.tenants.filter((tenant) => tenant.tenantId === tenantId);

  return {
    ...plan,
    // "Considered" becomes one: the question asked was about this tenant.
    tenantsConsidered: 1,
    tenantsConfigured: tenants.length,
    // In a one-tenant scope, a tenant that is not in the report is unconfigured.
    tenantsDisabled: tenants.length === 0 ? 1 : 0,
    tenants,
    totalCandidates: tenants.reduce((sum, tenant) => sum + tenant.candidates.length, 0),
    tenantsTruncated: tenants.filter((tenant) => tenant.truncated).length,
  };
}

/**
 * The process entry point.
 *
 * Exits non-zero for a usage error and for a missing `DATABASE_URL`, because a
 * dry run that printed an empty report because it could not connect is
 * indistinguishable from a run with nothing to do — and "nothing to do" is the one
 * answer that most needs corroboration here.
 */
export async function main(argv, env = process.env, out = console) {
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    out.error(parsed.reason);
    out.error('');
    out.error(USAGE);
    return EXIT_USAGE;
  }

  if (parsed.options.help) {
    out.log(USAGE);
    return EXIT_OK;
  }

  if (!env.DATABASE_URL) {
    out.error(
      'DATABASE_URL is not set, so there is nothing to report on. This script reads the ' +
        'database and nothing else — it needs no Google credentials, because the rule it reports ' +
        'on cannot call Google.',
    );
    return EXIT_NO_DATABASE_URL;
  }

  const plan = await loadPlan(parsed.options);

  if (parsed.options.json) {
    out.log(JSON.stringify(plan, null, 2));
  } else {
    out.log(renderPlan(plan, parsed.options));
  }

  // Zero whenever it ran, whatever it found. A non-zero exit for "candidates
  // exist" would make the normal, expected state of an opted-in tenant look like a
  // failure to any shell that checks it — and a tool whose success signal gets
  // trained away is a tool nobody runs before the change they needed it for.
  return EXIT_OK;
}

// Only run when invoked directly, so the test can import the pure parts without
// opening a connection.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
