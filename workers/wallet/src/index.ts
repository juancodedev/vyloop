import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { createDrizzleWalletStore, openTenantSession } from './drizzle-store';
import type { AuthHeaders, WalletBindings } from './helpers';
import {
  extractAuthHeaders,
  googleWalletClientFor,
  parseDemoMode,
  parsePublicBaseUrl,
} from './helpers';
import { provisionTenantClass } from './provision';
import type { ProvisionOutcome } from './provision';
import { reconcilePass } from './reconcile';
import type { ReconcileOutcome } from './reconcile';
import router from './routes';
import { runScheduledSweep } from './sweep';

/**
 * `@vyloop/wallet` — Google Wallet loyalty passes.
 *
 * ## Two halves
 *
 * The **pass model** (T1–T8) is pure: id derivation, the member code, the
 * `LoyaltyClass` and `LoyaltyObject` payloads, balance formatting, the
 * save-to-wallet signer and the Google REST client boundary. It has no database
 * and makes no network call, and none of that changed when the HTTP surface
 * landed.
 *
 * The **issuance surface** is this unit's HTTP half: three routes, a persistence
 * boundary, and the rules that decide whether a customer can obtain a pass.
 * Those rules live in `issuance.ts` as plain functions over a `WalletStore`, so
 * they can be broken one at a time without a database.
 *
 * The **sweep** is the third half: a daily scheduled job that reconciles every
 * pass in every tenant, so a customer who saves their pass and never opens the
 * app still sees a current balance at the till. It shares `reconcilePass` with
 * the request path, so the on-demand and batch balance projections cannot drift
 * apart. See `sweep.ts`.
 *
 * The fourth half is **push**, and it is one exported method: `reconcileCustomer`
 * below, called over a service binding by the growth worker at the moment the
 * ledger moves. Both existing triggers are *pull* — the pass is correct only if
 * the holder opens the app, and the sweep bounds the staleness at 24 hours,
 * which is longer than a shift. None of them knows a sale happened. All three
 * converge through the same `reconcilePass`, which is the property that makes a
 * third trigger safe to add.
 *
 * The fifth half is **onboarding**, and it is the other exported method:
 * `provisionClass` below, called over a service binding by the identity worker
 * the moment a business signs up. It creates the tenant's Google class and the
 * row that records it, in that order, and it is the first production caller of
 * `insertClass`. See `provision.ts`.
 *
 * ## T9 is still not here, and that is deliberate
 *
 * There is no "Add to Google Wallet" button anywhere in this repository, and
 * adding one is a separate change gated on publishing access. The API below is
 * what such a button would call, and `GET /v1/wallet/status` is the endpoint
 * that button would have to ask before rendering itself — so the control can
 * never appear over a pass that will fail. Stage 7's delivery gate in
 * `apps/customer-web` forbids the CTA until publishing access is granted, and
 * nothing in this worker relaxes it.
 *
 * Every account starts in Demo Mode, so even a working button would only reach
 * the issuer's own test accounts until Google's publishing approval lands. The
 * sweep honours the same var and does nothing at all while it is on.
 */

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

export type { AuthHeaders, WalletBindings } from './helpers';

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: WalletBindings; Variables: { auth: AuthHeaders } }>();

// ---------------------------------------------------------------------------
// Global middleware: auth header extraction
// ---------------------------------------------------------------------------

app.use('*', async (c, next) => {
  try {
    // Extract and validate auth headers (injected by gateway).
    extractAuthHeaders(c);

    await next();
  } catch (err) {
    if (err instanceof HTTPException) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: err.message } },
        err.status,
      );
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.route('/', router);

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.notFound((c) => {
  return c.json(
    { error: { code: 'NOT_FOUND', message: 'Route not found' } },
    404,
  );
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  console.error('[wallet] Unhandled error:', err);

  if (err instanceof HTTPException) {
    return c.json(
      { error: { code: 'ERROR', message: err.message } },
      err.status,
    );
  }

  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    500,
  );
});

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export * from './balance';
export * from './class';
export * from './drizzle-store';
export * from './google-client';
export * from './helpers';
export * from './ids';
export * from './issuance';
export * from './jwt';
export * from './member-code';
export * from './object';
export * from './provision';
export * from './reconcile';
export * from './store';
export * from './sweep';

// ---------------------------------------------------------------------------
// Scheduled trigger
// ---------------------------------------------------------------------------

/**
 * The daily reconciliation sweep.
 *
 * Exported both by name and on the default object, which is the convention
 * `workers/automation` sets and the one a reader comparing the two workers will
 * expect to find. Cloudflare's runtime reads whichever it finds; exporting one
 * and not the other is how a cron silently never fires.
 *
 * The `controller` argument carries `scheduledTime` and `cron`, and is ignored:
 * the sweep's own clock comes from `Date` inside `sweepPasses`, and a schedule
 * that could be overridden per-invocation would make the due filter's cutoff
 * ambiguous. The frequency is in `wrangler.jsonc` and documented, with its
 * justification, in `SWEEP_CRON`.
 *
 * Never throws. `sweepPasses` captures every failure into its report, because a
 * scheduled handler that throws has the entire invocation retried from the first
 * tenant — and a sweep stuck retrying a broken tenant never reaches tenant two.
 */
export async function scheduled(_controller: unknown, env: WalletBindings): Promise<void> {
  await runScheduledSweep(env);
}

// ---------------------------------------------------------------------------
// Push trigger
// ---------------------------------------------------------------------------

/** The two ids `reconcilePass` needs. The same pair the pass route builds. */
export interface ReconcileCustomerInput {
  /** `X-Business-Id` at the caller. The only tenant this call may touch. */
  tenantId: string;
  /** `customers.id`, not the token subject. */
  customerId: string;
}

/**
 * Project one customer's ledger balance onto their pass, now.
 *
 * ## Why this exists beside `scheduled`, and not as a route
 *
 * The two handlers that move a balance live in the growth worker, not here, so
 * this cannot be a route: they have to reach it, and a service binding invokes an
 * exported method directly. That is the same mechanism, and the same convention,
 * `workers/automation` already uses to dispatch the sweep with this worker's own
 * bindings and secrets.
 *
 * ## Why it delegates and does not decide anything
 *
 * Everything that decides is `reconcilePass`, called here exactly as the pass
 * route calls it. The tempting "optimisation" is to skip straight to the
 * tracking row because the caller only just wrote the ledger and already knows
 * the class is fine, and it should not be taken: the pass route already ran
 * `classReadinessFor`, and a second implementation of "is this class usable" is
 * a second answer to a question that decides whether this worker is allowed to
 * write to Google. Two answers, one reachable from a sale and one from a tap,
 * and they drift the first time a rule changes. The extra read is one program
 * lookup; a pass written for a class that cannot back it is a support incident.
 *
 * `demoMode` is passed rather than tested. It is a deployment fact, not a
 * per-call decision, and `reconcilePass` already consults it where it consults
 * every other readiness input.
 *
 * ## Why there is no Demo Mode early return, unlike `runScheduledSweep`
 *
 * The sweep refuses before it opens a database, because a job on a timer that
 * has already decided not to do its job should not connect to production. This
 * is not that: it is asked for by a specific customer, and the refusal that
 * matters — a `draft` class cannot back a pass — is `reconcilePass`'s to make.
 * Returning a `skipped` outcome from here would mean choosing a reason code,
 * which is re-deciding class readiness with a different answer. The cost of not
 * short-circuiting is a few reads per sale in an environment where every
 * reconcile ends in `skipped`, and that is cheaper than two vocabularies for
 * "not yet".
 *
 * ## Why the tenant session is opened here and the sweep opens none
 *
 * `openTenantSession` is what every route in this worker does, and it is
 * correct for a call that already knows its tenant — including the cost of the
 * pool it opens, which a sale now costs this worker the same way every other
 * request already does. The sweep's omission of it is documented in `sweep.ts`
 * and does not extend: it enumerates tenants, and setting one would hide every
 * other tenant's rows from itself. Reading a single known tenant's pass and
 * ledger without the session variable would quietly return nothing the day the
 * RLS policies are enabled, which is a balance that stops converging with no
 * error anywhere.
 *
 * ## Errors
 *
 * Throws whatever `reconcilePass` throws, including `PassPatchNotAppliedError`.
 * Swallowing here would leave the caller with a projection that reported
 * success and a pass showing the wrong number, which is the one outcome this
 * whole worker treats as a trust problem at the till. The caller — growth's
 * `schedulePassReconcile` — catches, because its contract is that a sale never
 * waits on or fails for a pass.
 */
export async function reconcileCustomer(
  input: ReconcileCustomerInput,
  env: WalletBindings,
): Promise<ReconcileOutcome> {
  const db = await openTenantSession(env.DATABASE_URL, input.tenantId);

  const outcome = await reconcilePass(
    {
      store: createDrizzleWalletStore(db),
      client: googleWalletClientFor(env),
      demoMode: parseDemoMode(env.WALLET_DEMO_MODE),
    },
    { tenantId: input.tenantId, customerId: input.customerId },
  );

  // Only the branch that wrote to Google. `not_saved` is the ordinary answer
  // for a customer who has never saved their pass, and on this path it is once
  // per sale rather than once per issued link, so logging it would bury the one
  // line a support question actually needs.
  if (outcome.kind === 'patched') {
    console.log(
      `[wallet] Push reconciled pass ${outcome.objectId} to balance ${outcome.balancePoints} ` +
        `for customer ${input.customerId} in tenant ${input.tenantId}.`,
    );
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Onboarding trigger
// ---------------------------------------------------------------------------

/**
 * Give a newly signed-up tenant its Google class and its program row.
 *
 * ## Why this is an export and not a route
 *
 * The only caller is the identity worker, at the moment a business signs up, and
 * it runs with this worker's Google credentials and *its* issuer account. A route
 * would need a forwarding `fetch`, and a `fetch` to this worker would have to
 * carry the service-account key across a boundary that takes tenant input. The
 * service binding calls the exported method directly, for the same reason
 * `reconcileCustomer` above is one.
 *
 * ## Why the caller does not wait for it
 *
 * It runs under the signup response's `waitUntil`, and this is where the cost
 * would land if it did not: a Google call is a network round trip to the slowest
 * and least reliable dependency this system has, inside a request a merchant is
 * watching a spinner for. A signup that fails because Google is down has also
 * thrown away a business that was perfectly registerable. The order inside
 * `provisionTenantClass` is what makes the delay safe — the business exists
 * before this is asked for, and this only adds a card to it.
 *
 * ## Errors
 *
 * Never throws. Every failure is a typed outcome, because this crosses a service
 * boundary into a `waitUntil` the caller cannot see: a rejection there is
 * attributed to an invocation whose visible result was a 201, so it would be a
 * logged stack trace with nothing to attach it to. The caller logs the code.
 *
 * Unlike `reconcileCustomer`, this **does** read `GOOGLE_WALLET_ISSUER_ID` — see
 * `ProvisionDeps.issuerId` for why a tenant with no row has no other authority.
 */
export async function provisionClass(
  input: { tenantId: string },
  env: WalletBindings,
): Promise<ProvisionOutcome> {
  const db = await openTenantSession(env.DATABASE_URL, input.tenantId);

  return provisionTenantClass(
    {
      store: createDrizzleWalletStore(db),
      client: googleWalletClientFor(env),
      issuerId: env.GOOGLE_WALLET_ISSUER_ID,
      publicBaseUrl: parsePublicBaseUrl(env.WALLET_PUBLIC_BASE_URL),
    },
    { tenantId: input.tenantId },
  );
}

export default { fetch: app.fetch.bind(app), scheduled, reconcileCustomer, provisionClass };
