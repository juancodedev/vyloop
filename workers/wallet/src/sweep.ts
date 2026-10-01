/**
 * The scheduled reconciliation sweep.
 *
 * ## The defect this closes
 *
 * `reconcile.ts` reconciles a pass when the customer opens the app. A customer
 * who saves their pass and never returns therefore keeps whatever number was
 * last pushed onto it — and that number is what staff read aloud at the till.
 * The pass is not wrong in a way anyone notices until a member is told the wrong
 * balance, which is the worst possible place to find out.
 *
 * A per-issuer sweep fixes it: one `loyaltyobject.list` per tenant covers every
 * customer who is not in the app, and only the objects whose balance actually
 * differs are written. This is Google's own suggestion.
 *
 * @see https://developers.google.com/wallet/retail/loyalty-cards/use-cases/updates
 *
 * ## The single projection path
 *
 * Every balance push in this file goes through `reconcilePass`. The sweep holds
 * the `LoyaltyObject` that `listObjects` returned and still lets
 * `reconcilePass` re-read it, which is an extra `getObject` per pass. That is
 * deliberate: passing the listed object in would create a second implementation
 * of "is this pass in sync, and what do we push", and two implementations of the
 * projection are exactly the drift this design refuses to allow. An N+1 read is
 * a cost; a second definition of a balance pushed onto a real pass is a defect.
 * The two extra reads per pass are also why the per-run budgets below exist.
 *
 * ## What the sweep writes that reconciliation does not
 *
 * The list response carries Google's `state`, which the per-customer path never
 * learns (`reconcilePass` only distinguishes `ACTIVE` from "not `ACTIVE`"). That
 * is the evidence for lifecycle tracking, and it is free here, so it is folded
 * into this change rather than left for a second one. See
 * `recordPassLifecycle` for why it is a separate statement and not a widening
 * of the existence guard.
 *
 * ## Resumability without new state
 *
 * There is no cursor column, and no "swept at" marker on the tenant, and that is
 * a decision rather than an omission. A completion marker is what makes a sweep
 * *un*resumable: a run that dies halfway has recorded the tenants it started, so
 * the next run skips them and the work is never finished.
 *
 * Instead, progress is measured per pass in the column that already means the
 * right thing — `customer_wallet_passes.last_synced_at`, documented as "the last
 * moment we got a definitive answer from Google". Every pass this run acts on
 * gets a timestamp of *this* run, so on the next run those passes are no longer
 * due and the sweep walks past them into objects it has not reached. A run that
 * dies at object 400 leaves objects 401+ untouched, so they are still due and
 * the next run reaches them. Nothing is recorded that could be wrong, so
 * nothing needs to be undone.
 *
 * That sentence was **false** until recently, and the false part was load
 * bearing. Three shapes of pass wrote no timestamp at all: an object whose state
 * is `PENDING` or otherwise unmappable, a row in a terminal state whose
 * reconciliation write its rank guard refused, and a row whose lifecycle write
 * matched no rows. Each stayed due for ever, each was re-read from Google and
 * the ledger on every run, and a tenant holding `MAX_RECONCILES_PER_TENANT` of
 * them never got past them — permanently `deferred`, indefinitely, with a report
 * that looked like ordinary deferral. The guarantee above is now actually true,
 * and `observationsNotRecorded` is the counter that says when it stops being
 * true.
 *
 * The honest cost, stated rather than glossed: **Google's page tokens are
 * opaque and sequential, so a deferred tenant re-lists the pages it already
 * read.** The list calls repeat. The per-object work — the `getObject`, the
 * ledger read, the patch — does not, because the due filter skips it. For a
 * tenant far larger than one invocation's budget, the list calls are the price
 * of not needing a durable cursor, and this file reports `deferred` so that cost
 * is visible rather than inferred.
 */

import { createDb } from '@vyloop/db';

import { createDrizzleWalletStore } from './drizzle-store';
import type { GoogleWalletClient } from './google-client';
import type { WalletBindings } from './helpers';
import {
  googleWalletClientFor,
  parseDemoMode,
  parseMediaBaseUrl,
  parseWebBaseUrl,
} from './helpers';
import { classReadinessFor } from './issuance';
import { normaliseGoogleObjectState, type GoogleObjectState, type LoyaltyObject } from './object';
import { provisionTenantClass } from './provision';
import type { ProvisionDeps } from './provision';
import { reconcilePass } from './reconcile';
import type { ReconcileOutcome } from './reconcile';
import type { PassLifecycleState, WalletPassRow, WalletStore } from './store';

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

/**
 * `0 6 * * *` — once a day at 06:00 UTC, expressed exactly as `workers/automation`
 * expresses its own daily crons, because a second convention for the same thing
 * in the same repository is a thing somebody has to look up.
 *
 * ## Why daily, against two real constraints
 *
 * **Google's cap.** Field-update notifications are capped at three per pass per
 * 24 hours. A pass that changed balance four times in a day and was pushed four
 * times would exhaust that budget and the member would get no notification for
 * their last purchase — the sweep would make the customer experience *worse*
 * exactly when they are spending. Hourly or six-hourly sweeping is therefore not
 * merely wasteful, it is actively harmful once a customer has three balance
 * changes in a day. Daily caps us at one push per pass per day: a third of the
 * cap, leaving the other two thirds for a manual correction.
 *
 * **How often a balance moves.** A points ledger changes on a purchase or a
 * redemption — for a retail or hospitality loyalty programme, at most a couple
 * of times a week per member. Sweeping more often than that spends a list call
 * and a ledger read to rediscover a number that did not change, which is the
 * definition of wasted quota.
 *
 * ## What daily costs, stated plainly
 *
 * A member who spends at 09:00 sees the updated balance on their pass by 06:00
 * the next day. So the sweep turns an *unbounded* stale window — a customer who
 * never returns the app never converges, ever — into a bounded one of at most 24
 * hours. That is the actual improvement, and it is worth being precise about it
 * rather than describing the result as "up to date".
 */
export const SWEEP_CRON = '0 6 * * *';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Tenants walked, and fetched, in one invocation. The enumeration bound.
 *
 * This is **the** bound, and the sweep issues exactly one `listProgramTenants`
 * call per run with this as the `limit`, so an invocation cannot read an
 * unbounded tenant list no matter how many merchants there are. A tenant is a
 * *merchant*, so the count is orders of magnitude below the pass count: a
 * merchant with 50,000 passes is still one row here.
 *
 * ## Why the sweep always starts from the beginning
 *
 * `listProgramTenants` is keyset-paged and can resume from a cursor, but the
 * sweep deliberately passes `afterTenantId: null` every run. Resuming from a
 * stored cursor would need a place to store it, and the only place available is
 * a new column — and a completion marker is what makes a sweep non-resumable.
 * Restarting from the lowest tenant id each run means the same tenants are
 * walked first, which is a real liveness limit once the merchant count exceeds
 * this bound: tenants past it are not reached at all, not merely reached late.
 * That is stated here rather than solved, because the honest fix is a fair
 * scheduler (order by least-recently-verified) and that belongs in its own
 * change with its own migration. What this bound *does* guarantee, and what the
 * per-pass due filter extends to every pass inside a walked tenant, is that
 * nothing reachable is ever skipped.
 */
export const MAX_TENANTS_PER_RUN = 25;

/**
 * Tenants given a Google class in one invocation, if they have none. A **separate**
 * budget from `MAX_TENANTS_PER_RUN`, and separate on purpose.
 *
 * ## Why it is not the same number
 *
 * `MAX_TENANTS_PER_RUN` bounds reconciliation, and its own comment says the
 * tenants past it "are not reached at all, not merely reached late". A tenant with
 * a row is a business whose customers have passes, and those passes are what the
 * sweep exists for. A tenant without a row is a business whose signup lost a
 * background call — usually one business at a time, and usually recoverable by the
 * next signup.
 *
 * Charging the second group against the first group's budget is how the accounts
 * already on the platform stop being swept: one day with a bad Google outage and
 * every reconciliation pass that day goes to provisioning a tenant that has no
 * customers yet. So this is its own constant, and `runScheduledSweep` keeps it
 * visibly separate in the report.
 *
 * ## Why ten
 *
 * - **The population is small and bursty.** It is the number of signups that
 *   happened while Google was unwell — not the merchant count. Ten in a day is
 *   more than this platform signs up.
 * - **It is below the reconciliation bound on purpose.** If the two numbers ever
 *   drifted to the same value, "which half is this budget for" would become a
 *   question a reader has to answer from context. Ten against twenty-five says it
 *   without a comment.
 * - **What one of them costs.** A provisioning attempt is one `insertClass` plus
 *   three short reads and one insert. Reconciliation, for comparison, is up to
 *   `MAX_PAGES_PER_TENANT` list calls and `MAX_RECONCILES_PER_TENANT` `getObject`
 *   calls *per tenant*. Ten of the cheap thing is already generous against twenty
 *   -five of the expensive one.
 *
 * ## Why a tenant that fails for ever is still bounded
 *
 * There is no attempt counter, so nothing moves a failing tenant to the back of
 * the queue. Three properties make the cost bounded anyway, and all three are
 * needed — remove any one and a permanently broken tenant starts costing:
 *
 * 1. **A deterministic order** (`tenants.id`, ascending, by keyset). Which
 *    tenants the budget reaches must not depend on which run it was or on whether
 *    an earlier tenant failed.
 * 2. **This budget.** One `insertClass` per attempt and at most
 *    `MAX_PROVISION_PER_RUN` attempts, so the daily Google write spend of this
 *    feature is ten calls, whatever the backlog is.
 * 3. **Success removes a tenant from the set.** The only thing that moves a
 *    tenant is the row it now has, so a healthy backlog drains from the front and
 *    a permanently failing tenant is retried once a day and costs one call.
 *
 * That last one is also why the bound is survivable: it delays rather than
 * excludes, and the delay is a day per batch of ten.
 */
export const MAX_PROVISION_PER_RUN = 10;

/**
 * `maxResults` sent to `loyaltyobject.list`.
 *
 * Google's documentation for this endpoint gives no maximum for `maxResults` —
 * it says only that omitting it returns everything — so this is a choice made
 * against the shape of the data rather than against a documented cap. A hundred
 * is comfortably larger than the 20 Google's own pagination example uses and
 * small enough that one page's worth of objects is a bounded amount of memory.
 */
export const OBJECT_PAGE_SIZE = 100;

/**
 * Google pages read per tenant per invocation.
 *
 * The *listing* bound, in units of Google's quota and of round trips. Five pages
 * is 500 objects read before the sweep moves to the next tenant, so a tenant
 * with 50,000 passes cannot consume the whole invocation.
 */
export const MAX_PAGES_PER_TENANT = 5;

/**
 * Passes acted on per tenant per invocation.
 *
 * The *work* bound, and the one that actually matters for cost: each acted-on
 * pass costs a `getObject`, a ledger read and possibly a `patch`. Separated from
 * `MAX_PAGES_PER_TENANT` because the two bound different resources — a tenant
 * can have 500 objects listed and 40 of them due, and the run should finish the
 * 40 rather than stop at the page boundary.
 */
export const MAX_RECONCILES_PER_TENANT = 200;

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** One thing that went wrong, with the tenant it went wrong for. */
export interface SweepFailure {
  tenantId: string;
  /**
   * Which stage failed, so a reader knows whether to retry or to fix config.
   *
   * The two provisioning stages are separate from the reconciliation ones because
   * they mean different things to whoever reads the log: `reconcile` is a tenant
   * that has customers whose balances may now be stale, and `provision` is a
   * merchant who has no card yet. One is a support ticket about a number, the
   * other is a signup that lost its background call.
   */
  stage:
    | 'list_tenants'
    | 'list_objects'
    | 'resolve_passes'
    | 'reconcile'
    | 'list_unprovisioned_tenants'
    | 'provision';
  reason: string;
}

export interface SweepReport {
  /**
   * Whether the run refused to do anything because this deployment is in Demo
   * Mode. When true, every other counter is zero because nothing was called.
   */
  demoMode: boolean;
  /** Tenants whose class could not back a pass, so nothing was asked of Google. */
  tenantsSkipped: number;
  /** Tenants whose objects were listed without incident. */
  tenantsSwept: number;
  /** Tenants that hit a per-run bound and will continue on the next run. */
  tenantsDeferred: number;
  /** Tenants that failed. Each is retried on the next run. */
  tenantsFailed: number;
  /** `loyaltyobject.list` calls issued. */
  listCalls: number;
  /** Google objects returned across all pages. */
  objectsSeen: number;
  /** Passes this run actually acted on, after the due filter and the budget. */
  passesActedOn: number;
  /** Passes skipped because a run in this window already verified them. */
  passesSkippedNotDue: number;
  /** Google objects with no pass row of ours. Not actionable, and not ignored. */
  objectsWithoutPassRow: number;
  /**
   * Lifecycle states **actually recorded**, by state.
   *
   * A count here means a row really changed. It used to mean "we called a method
   * that did not complain", which is not the same thing at all — see
   * `lifecycleWritesSkipped`.
   */
  lifecycleWrites: Record<PassLifecycleState, number>;
  /**
   * Lifecycle answers Google gave that the guard refused to record, because the
   * row does not already assert the object exists.
   *
   * ## How to read a non-zero value
   *
   * This is not a transient error and it is not in `failures` for that reason:
   * nothing about waiting will change it, so reporting it as a failure would
   * train a support reader to ignore failures.
   *
   * It is one specific, actionable statement: **Google holds an active object
   * for a pass this system never confirmed exists.** The usual shape is a row in
   * `not_saved`, which `reconcile.ts` writes on every `getObject` 404 — a
   * 404 that the codebase itself calls "far more likely a propagation
   * artifact" than a customer deleting their pass. So the pass is very likely
   * real and our row is very likely behind, and the lifecycle write that would
   * have caught it up is exactly the one the existence guarantee forbids.
   *
   * It stays permanently re-reported for as long as the disagreement lasts.
   * A sweep report carrying this counter is a report asking for a human to look
   * at one customer's tracking row, not a report saying a run failed.
   */
  lifecycleWritesSkipped: number;
  /**
   * Passes whose existence observation could not be recorded at all, because the
   * row disappeared between being read and being written.
   *
   * The one liveness hole left in the report. A pass in this bucket is still in
   * the due set on the next run, so a non-zero value is a pass being re-read
   * from Google for ever. It should be near-impossible; if it is not, the row is
   * being deleted underneath the sweep.
   */
  observationsNotRecorded: number;
  /** Every `reconcilePass` outcome, tallied. The balance path's whole story. */
  outcomes: Record<ReconcileOutcome['kind'], number>;
  /**
   * Tenants this run found with no `tenant_wallet_programs` row.
   *
   * Not the same as `classesProvisioned`, and the difference is the interesting
   * part: it is the size of the page the enumeration returned, so a report where
   * it exceeds the number provisioned is a report saying the backlog is larger
   * than one run reaches. That is a fact about the backlog rather than a failure,
   * and it is reported as its own counter so it cannot be read as one.
   */
  tenantsWithoutProgram: number;
  /**
   * Tenants this run gave a Google class to, or finished giving one to.
   *
   * Counts every outcome that left the tenant holding a row, which includes the
   * `409 alreadyExists` case where the class was already at Google from a run that
   * died before its row was written.
   */
  classesProvisioned: number;
  /** Tenants whose provisioning failed. Each is retried by a later run. */
  tenantsProvisioningFailed: number;
  failures: SweepFailure[];
}

function emptyOutcomeCounts(): Record<ReconcileOutcome['kind'], number> {
  return {
    skipped: 0,
    no_tracking_row: 0,
    balance_not_displayable: 0,
    skipped_reason: 0,
    object_not_active: 0,
    not_saved: 0,
    in_sync: 0,
    patched: 0,
  };
}

function emptyReport(demoMode: boolean): SweepReport {
  return {
    demoMode,
    tenantsSkipped: 0,
    tenantsSwept: 0,
    tenantsDeferred: 0,
    tenantsFailed: 0,
    listCalls: 0,
    objectsSeen: 0,
    passesActedOn: 0,
    passesSkippedNotDue: 0,
    objectsWithoutPassRow: 0,
    lifecycleWrites: { inactive: 0, expired: 0, completed: 0 },
    lifecycleWritesSkipped: 0,
    observationsNotRecorded: 0,
    outcomes: emptyOutcomeCounts(),
    tenantsWithoutProgram: 0,
    classesProvisioned: 0,
    tenantsProvisioningFailed: 0,
    failures: [],
  };
}

// ---------------------------------------------------------------------------
// Lifecycle mapping
// ---------------------------------------------------------------------------

/**
 * Map Google's object state onto a tracking state we are willing to record, or
 * `null` for "do not record anything".
 *
 * ## The three that map
 *
 * `INACTIVE`, `EXPIRED` and `COMPLETED` are positive claims about an object
 * that exists, which is exactly what a lifecycle state asserts, and each has a
 * member-facing meaning: a deactivated pass, a lapsed one, a spent one. Before
 * the sweep, a customer who deleted their pass left a row reading `issued`
 * forever, because nothing in the system had ever asked Google.
 *
 * ## The three that do not
 *
 * - `ACTIVE` is the normal case and is the *existence* path's business. Writing
 *   `issued` from here would be redundant with, and could contradict,
 *   `reconcilePass`'s own conclusion.
 * - `PENDING` means the platform holds an object the user has not activated.
 *   There is no `pending` in `PassTrackingState` and inventing one would put a
 *   word in the schema that no other code would know how to read.
 * - `STATE_UNSPECIFIED`, and any value added to Google's enum after this was
 *   written, map to `null`. Failing closed here is the difference between "we
 *   did not understand Google's answer" and "we recorded a state that does not
 *   exist".
 */
export function lifecycleStateFor(
  googleState: GoogleObjectState | string | null | undefined,
): PassLifecycleState | null {
  // Normalised, because Google answers lower case. A switch over the raw
  // value returned null for every real response, and null reads as "nothing to
  // do" — so a pass Google had retired stayed active in our records for as long
  // as the account existed.
  switch (normaliseGoogleObjectState(googleState)) {
    case 'INACTIVE':
      return 'inactive';
    case 'EXPIRED':
      return 'expired';
    case 'COMPLETED':
      return 'completed';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface SweepDeps {
  store: WalletStore;
  /** Injected, so the whole sweep is exercisable without a credential. */
  client: GoogleWalletClient;
  /**
   * Clock. Defaults to the system clock. It is also the *due cutoff*: every pass
   * verified by this run is stamped at or after it, which is what makes a second
   * run skip the first run's work.
   */
  now?: Date | undefined;
  /**
   * The deployment-wide demo mode, from `WALLET_DEMO_MODE`.
   *
   * Required, for the same reason it is required on `ReconcileDeps`: it decides
   * whether a `draft` class may be touched, and a defaulted value that happened
   * to be the wrong one would widen what this worker writes to Google.
   */
  demoMode: boolean;
  /**
   * What a class is built from: the issuer id and the two public hosts.
   *
   * A nested object rather than three more fields, because these three are the
   * provisioning path's inputs and reconciliation reads none of them. A change to
   * what a class is made of therefore cannot reach the balance path by being
   * added to a flat dependency object, and the call site has to name them as a
   * group or not at all.
   *
   * The issuer id is read from the deployment rather than from a row, which is
   * the one place that is true: a tenant with no row has no issuer to consult.
   * See `ProvisionDeps.issuerId`.
   */
  provisioning: Omit<ProvisionDeps, 'store' | 'client'>;
}

export interface SweepInput {
  /**
   * Whether this deployment lacks Google's publishing access.
   *
   * Required rather than defaulted. A scheduled job that forgot the check would
   * be a background process writing to Google without consent, and the cheapest
   * way to make that impossible to express is to make the caller state the fact
   * rather than have the sweep guess it. `runScheduledSweep` derives it from
   * `parseDemoMode`, which fails closed.
   */
  demoMode: boolean;
}

/**
 * Reconcile every pass in every tenant that has a class row, and provision a
 * bounded number of the tenants that have none.
 *
 * Never throws. Every failure is captured in the returned report, because a
 * scheduled handler that threw would have the whole invocation retried from
 * page one — and a sweep that is retried from the start forever, while one tenant
 * is broken, is a sweep that never reaches tenant two.
 *
 * ## The two halves run in that order, and neither shares the other's budget
 *
 * Reconciliation first, because it is the half customers are waiting on: a pass
 * whose balance is a day stale is an active support problem, while a business
 * without a class is a business whose customers cannot get a pass yet at all. A
 * backstop for a broken signup has no business delaying the sweep that exists.
 *
 * They do not touch each other's budgets, and the tests that pin that are the
 * ones worth keeping: a change that let the (usually small, usually self-healing)
 * unprovisioned backlog draw on the reconciliation bound would silently stop the
 * passes of every already-provisioned merchant from being swept. See
 * `MAX_PROVISION_PER_RUN`.
 */
export async function sweepPasses(deps: SweepDeps, input: SweepInput): Promise<SweepReport> {
  const report = emptyReport(input.demoMode);

  // Checked before the store and the client, and asserted by a test that both go
  // uncalled. In Demo Mode this deployment has no publishing access, so a pass
  // it pushed would only ever be visible on the issuer's own test accounts;
  // there is no account it is *permitted* to write to, and a background process
  // that forgets this writes to Google on a schedule nobody consented to.
  if (input.demoMode) {
    return report;
  }

  const observedAt = deps.now ?? new Date();

  let tenants;
  try {
    tenants = await deps.store.listProgramTenants({
      limit: MAX_TENANTS_PER_RUN,
      afterTenantId: null,
    });
  } catch (err: unknown) {
    report.failures.push({ tenantId: '', stage: 'list_tenants', reason: describe(err) });
    return report;
  }

  for (const program of tenants) {
    // The safety rule, before anything is asked of Google and before any row is
    // read for this tenant. Reusing `classReadinessFor` rather than testing
    // `review_status = 'approved'` here is the point: a class Google has not
    // approved cannot have live objects, and a sweep that patched anyway would
    // be the one code path in this worker that writes to Google without the
    // class being ready — the exact thing the pass route refuses to do.
    const readiness = classReadinessFor(program, program.tenantId, input.demoMode);
    if (!readiness.ok) {
      report.tenantsSkipped += 1;
      continue;
    }

    try {
      const outcome = await sweepTenant(deps, program.tenantId, readiness.classId, observedAt, report);
      if (outcome === 'deferred') {
        report.tenantsDeferred += 1;
      } else {
        report.tenantsSwept += 1;
      }
    } catch (err: unknown) {
      // Scoped to one tenant. The next tenant is swept, and this one is retried
      // on the next run because nothing recorded that it was done.
      report.tenantsFailed += 1;
      report.failures.push({
        tenantId: program.tenantId,
        stage: err instanceof TenantStageError ? err.stage : 'reconcile',
        reason: describe(err),
      });
    }
  }

  // After the reconciliation loop, and deliberately not inside it: a tenant
  // provisioned here is `draft` with no passes, so there is nothing of its own to
  // reconcile in this run either way. The order is about priority, not about a
  // dependency.
  await provisionMissingClasses(deps, report);

  return report;
}

/**
 * Give a Google class to the tenants that never got one.
 *
 * ## Why this goes straight to `provisionTenantClass` and not through the loop above
 *
 * The loop above gates every tenant on `classReadinessFor`, which rejects anything
 * that is not `approved` and answers `class_not_provisioned` for a tenant with no
 * row. That gate is the right one for a sweep that is about to write to a pass:
 * a class Google has not approved cannot have live objects, and patching anyway
 * would be the one path in this worker that writes to Google without the class
 * being ready.
 *
 * It is the wrong gate here, because this loop's whole purpose is to *make* the
 * class. Passing these tenants through a check that refuses to act on an
 * unprovisioned tenant would either provision nobody or, worse, invert the check
 * so the sweep provisions everything on the platform. So provisioning arrives by
 * its own path, on its own budget, reporting its own counters — and it is the
 * same `provisionTenantClass` the signup route calls, which is what keeps the
 * "Google first, then the row" ordering in one place instead of two.
 *
 * ## Isolation is per tenant, because Google is a shared dependency
 *
 * A failure is caught inside the loop. If Google is unreachable for one class it
 * is very likely unreachable for the next, and a loop that let the first throw end
 * the run would report one failure instead of every tenant that needs one — which
 * is the same silent-blindness the per-tenant isolation exists to avoid on the
 * reconciliation side.
 */
async function provisionMissingClasses(deps: SweepDeps, report: SweepReport): Promise<void> {
  let tenantIds: string[];
  try {
    tenantIds = await deps.store.listTenantsWithoutProgram({
      limit: MAX_PROVISION_PER_RUN,
      // No cursor, like `listProgramTenants`: the enumeration is one bounded page
      // per run, and the row each success writes is what makes progress. A stored
      // cursor would need a column, which is the completion marker that makes a
      // sweep non-resumable.
      afterTenantId: null,
    });
  } catch (err: unknown) {
    // Its own stage, so a reader knows this was the database rather than Google,
    // and knows the reconciliation half of this run was not affected by it.
    report.failures.push({
      tenantId: '',
      stage: 'list_unprovisioned_tenants',
      reason: describe(err),
    });
    return;
  }

  report.tenantsWithoutProgram += tenantIds.length;

  for (const tenantId of tenantIds) {
    try {
      const outcome = await provisionTenantClass(
        { store: deps.store, client: deps.client, ...deps.provisioning },
        { tenantId },
      );

      if (outcome.kind === 'failed') {
        report.tenantsProvisioningFailed += 1;
        report.failures.push({
          tenantId,
          stage: 'provision',
          reason: `${outcome.code}: ${outcome.message}`,
        });
        continue;
      }

      // Every other outcome left the tenant holding a row, including
      // `already_exists` (the class was at Google and only the record was missing)
      // and `already_provisioned` (a signup won the race between the enumeration
      // and this call). Both are the state this loop exists to reach.
      report.classesProvisioned += 1;
      console.log(`[wallet] Provisioned the Google class ${outcome.classId} for tenant ${tenantId}.`);
    } catch (err: unknown) {
      // `provisionTenantClass` does not throw, so this is unreachable today and is
      // here for the day someone edits it. It is still a per-tenant catch, because
      // the alternative is that one edit to the provisioning module silently
      // becomes "the sweep stopped provisioning" with every counter reading zero.
      report.tenantsProvisioningFailed += 1;
      report.failures.push({ tenantId, stage: 'provision', reason: describe(err) });
    }
  }
}

type TenantOutcome = 'complete' | 'deferred';

/**
 * List one tenant's objects and reconcile the ones that are due.
 *
 * A throw from here is a tenant-level failure. A per-pass failure is caught
 * inside, so one customer's pass being un-reconcilable does not abandon the
 * other 4,999 in the same tenant.
 */
async function sweepTenant(
  deps: SweepDeps,
  tenantId: string,
  classId: string,
  observedAt: Date,
  report: SweepReport,
): Promise<TenantOutcome> {
  let token: string | undefined;
  let page = 0;
  let budgetExhausted = false;

  while (page < MAX_PAGES_PER_TENANT) {
    let listed;
    try {
      listed = await deps.client.listObjects({
        classId,
        maxResults: OBJECT_PAGE_SIZE,
        ...(token === undefined ? {} : { token }),
      });
    } catch (err: unknown) {
      throw new TenantStageError(tenantId, 'list_objects', err);
    }

    report.listCalls += 1;
    report.objectsSeen += listed.objects.length;
    page += 1;

    let rows: WalletPassRow[];
    try {
      rows = await deps.store.findPassesByObjectIds(
        listed.objects.map((object) => object.id),
        tenantId,
      );
    } catch (err: unknown) {
      throw new TenantStageError(tenantId, 'resolve_passes', err);
    }

    const rowsByObjectId = new Map(rows.map((row) => [row.objectId, row]));

    for (const object of listed.objects) {
      const row = rowsByObjectId.get(object.id);
      if (row === undefined) {
        // Google holds an object we have no row for. Counted, never acted on:
        // without a `customerId` there is no ledger to read and no row to
        // update, and inventing a row from a listed object would let a console-
        // created pass into the ledger.
        report.objectsWithoutPassRow += 1;
        continue;
      }

      // The due filter. A pass this run has already verified is stamped at or
      // after `observedAt`, so it is skipped — which is what stops a second
      // `getObject` and a second ledger read for work already done in this same
      // invocation, and what makes a deferred tenant pick up where it left off.
      if (row.lastSyncedAt !== null && row.lastSyncedAt.getTime() >= observedAt.getTime()) {
        report.passesSkippedNotDue += 1;
        continue;
      }

      if (report.passesActedOn >= MAX_RECONCILES_PER_TENANT) {
        budgetExhausted = true;
        break;
      }

      await sweepOnePass(deps, object, row, observedAt, report);
      report.passesActedOn += 1;
    }

    if (budgetExhausted) return 'deferred';

    // The last page. Every object this invocation will reach has been reached.
    if (listed.nextPageToken === null) return 'complete';

    token = listed.nextPageToken;
  }

  // Out of page budget with a token still in hand: this tenant has more objects
  // than one invocation covers, and the next run continues from the passes it
  // has not stamped.
  return 'deferred';
}

/**
 * One pass: record its lifecycle, then reconcile its balance.
 *
 * Both steps, in that order, and the lifecycle step first because it is the one
 * that cannot be recovered by re-running: a pass Google reports as `EXPIRED` is
 * terminal in the tracking row, and if the balance step then throws, the run is
 * retried and the lifecycle write is idempotent anyway. Doing it the other way
 * round would leave a window where the balance was pushed onto a pass already
 * recorded as expired.
 *
 * Lifecycle is written and then reconciliation still runs, because
 * `reconcilePass` independently re-reads the object and will itself return
 * `object_not_active` for anything that is not `ACTIVE`. The two agree because
 * both ask the same question of the same object; neither trusts the other's
 * answer.
 *
 * That second step is also what keeps a zero-row lifecycle write from becoming a
 * stuck pass. When the source set refuses the write, the state and the timestamp
 * both go untouched, so nothing here would have moved the pass out of the due
 * set — but `reconcilePass` records the observation separately, without a state
 * claim, and does. The fallback is not a second path: it is the same projection
 * call this function already makes for every pass.
 */
async function sweepOnePass(
  deps: SweepDeps,
  object: LoyaltyObject,
  row: WalletPassRow,
  observedAt: Date,
  report: SweepReport,
): Promise<void> {
  const lifecycle = lifecycleStateFor(object.state);
  if (lifecycle !== null) {
    try {
      // The returned count is the whole point of the call. A lifecycle write can
      // legitimately match no rows, and counting it as one would report an
      // observation this system does not hold.
      const rowsChanged = await deps.store.recordPassLifecycle({
        customerId: row.customerId,
        tenantId: row.tenantId,
        state: lifecycle,
        observedAt,
      });
      if (rowsChanged > 0) {
        report.lifecycleWrites[lifecycle] += 1;
      } else {
        report.lifecycleWritesSkipped += 1;
      }
    } catch (err: unknown) {
      // A lifecycle write that fails is reported and the balance reconciliation
      // still runs. Losing the balance is worse than losing the lifecycle, and
      // `reconcilePass` will return `object_not_active` for this object anyway,
      // so no balance is pushed to a pass the platform has retired.
      report.failures.push({
        tenantId: row.tenantId,
        stage: 'reconcile',
        reason: `lifecycle ${lifecycle}: ${describe(err)}`,
      });
    }
  }

  try {
    const outcome = await reconcilePass(
      { store: deps.store, client: deps.client, now: observedAt, demoMode: deps.demoMode },
      { tenantId: row.tenantId, customerId: row.customerId },
    );
    report.outcomes[outcome.kind] += 1;

    // The only outcome that can leave a pass due without the sweep having
    // learned why. `reconcilePass` records the observation for an object that
    // exists but is not `ACTIVE`, which is what gets a `PENDING` or
    // `STATE_UNSPECIFIED` pass out of the due set; if that write changed no row
    // the pass is still due, and only this counter says so.
    if (outcome.kind === 'object_not_active' && !outcome.observationRecorded) {
      report.observationsNotRecorded += 1;
    }

    if (outcome.kind === 'patched') {
      console.log(
        `[wallet] Sweep reconciled ${outcome.objectId} to ${outcome.balancePoints} for customer ` +
          `${row.customerId} in tenant ${row.tenantId}.`,
      );
    }
  } catch (err: unknown) {
    // `PassPatchNotAppliedError` lands here, and so does a 403 from a service
    // account that was never invited. Both are per-pass and neither may end the
    // run: a pass that cannot be patched is retried tomorrow, and the other
    // passes in this tenant are not held up by it.
    report.failures.push({
      tenantId: row.tenantId,
      stage: 'reconcile',
      reason: `customer ${row.customerId}: ${describe(err)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// The Workers boundary
// ---------------------------------------------------------------------------

/**
 * The `scheduled` handler's body, kept out of `index.ts` so it can be tested.
 *
 * ## The demo check is here *and* in `sweepPasses`, and both are load-bearing
 *
 * `sweepPasses` refuses, because that is the rule and the tests assert it
 * against the function that owns it. This function also refuses, **before
 * `createDb`**, because in Demo Mode the sweep must not open a database
 * connection at all: a scheduled handler that connects to production on a timer
 * for a job it has already decided not to do is a dependency with no upside.
 * One boolean, checked twice, at two different boundaries.
 *
 * ## Why no tenant RLS session is opened
 *
 * `openTenantSession` sets `app.current_tenant_id`, which is correct for the
 * request path and wrong for the enumeration: there is no tenant yet when
 * `listProgramTenants` runs, and setting one would hide every row from every
 * other tenant. So this opens a bare session and lets the cross-tenant query be
 * the cross-tenant query. See the RLS note on `listProgramTenants`: this returns
 * nothing once the tenant policies are enabled, and that is a known, named gap
 * rather than a surprise.
 */
export async function runScheduledSweep(env: WalletBindings): Promise<SweepReport> {
  const demoMode = parseDemoMode(env.WALLET_DEMO_MODE);

  if (demoMode) {
    console.log(
      '[wallet] WALLET_DEMO_MODE is on, so the reconciliation sweep did not run. This deployment ' +
        'has no Google publishing access and the sweep is a background writer; it does not ' +
        'connect to the database or call Google while the deployment is in Demo Mode.',
    );
    return emptyReport(true);
  }

  const db = createDb(env.DATABASE_URL);
  const report = await sweepPasses(
    {
      store: createDrizzleWalletStore(db),
      client: googleWalletClientFor(env),
      demoMode,
      // The issuer and the two hosts, read from the deployment because a tenant
      // with no row has no issuer to consult — the one place that is true. See
      // `ProvisionDeps.issuerId`.
      provisioning: {
        issuerId: env.GOOGLE_WALLET_ISSUER_ID,
        mediaBaseUrl: parseMediaBaseUrl(env.WALLET_MEDIA_BASE_URL),
        webBaseUrl: parseWebBaseUrl(env.WALLET_WEB_BASE_URL),
      },
    },
    { demoMode },
  );

  console.log(
    `[wallet] Sweep complete: ${report.tenantsSwept} swept, ${report.tenantsDeferred} deferred, ` +
      `${report.tenantsSkipped} skipped, ${report.tenantsFailed} failed, ${report.listCalls} list ` +
      `calls, ${report.passesActedOn} passes acted on (${report.outcomes.patched} patched, ` +
      `${report.outcomes.in_sync} already in sync), ${report.classesProvisioned} classes ` +
      `provisioned of ${report.tenantsWithoutProgram} tenants without one, ` +
      `${report.tenantsProvisioningFailed} provisioning failures, ` +
      `${report.failures.length} failures.`,
  );

  return report;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A failure attributed to a tenant and a stage, so `sweepPasses` can report it. */
class TenantStageError extends Error {
  readonly stage: SweepFailure['stage'];

  constructor(tenantId: string, stage: SweepFailure['stage'], cause: unknown) {
    super(`${stage} failed for tenant ${tenantId}: ${describe(cause)}`);
    this.name = 'TenantStageError';
    this.stage = stage;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
