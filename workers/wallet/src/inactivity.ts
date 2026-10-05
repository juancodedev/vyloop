/**
 * Deactivate a tenant's Google Wallet passes after X months without activity.
 *
 * ## What this rule is
 *
 * A platform rule, per tenant: a customer whose ledger has not moved for X months
 * has their pass set to `INACTIVE` at Google, and the tracking row follows. It is
 * the loyalty-programme equivalent of a card expiring, and it is opt-in per
 * tenant because the first run of it is a mass state change over real customers'
 * phones.
 *
 * ## `inactive`, never `expired` or `completed`
 *
 * `store.ts` documents the reason and it is mechanical, not stylistic: a
 * lifecycle state may only be written from a row in `('issued', 'inactive')`, so
 * `expired` and `completed` are **terminal** — nothing can move a row off them.
 * They are Google's states too, and Google cannot un-expire an object.
 *
 * `inactive` is in the source set precisely because the reverse transition is
 * real: when a customer re-adds the card in Google Wallet, `reconcile.ts` records
 * `issued` against the same row. That loop already works and is verified in
 * production, so this rule writes a state the system knows how to undo by
 * waiting, rather than one it cannot.
 *
 * ## Activity is `points_transactions`, and a redemption counts
 *
 * `points_transactions.points` is a **signed** integer, so a redemption is a
 * negative row. The predicate here is "a row exists inside the window", never
 * "points went up". Reading activity as an increase would mute precisely the
 * customer who spends the most, which is the customer a loyalty programme can
 * least afford to lose — and it would be a bug that only manifests with the
 * best customers, which is the worst way for one to be found.
 *
 * ## The boundary is `lastActivity < cutoff`, strict
 *
 * A customer whose last movement is *exactly* X months old has been inactive for
 * exactly X months, not longer than X months, so they are still in. The costs are
 * asymmetric: muting somebody who transacted inside their own window is an
 * incident this system cannot undo, and holding somebody for one extra day is a
 * delay nobody reports. `>=` on the deactivation side would put the boundary
 * customer in the wrong bucket, which is the case the brief asks to be decided
 * rather than left to whichever comparison was typed.
 *
 * ## Two halves, and the split is the design
 *
 * **Decide** — `planInactivityDeactivation` — is a `SELECT` over
 * `points_transactions` and `customer_wallet_passes`. It cannot reach Google: its
 * dependency object has no `client` field, so a dry run is not a flag that can be
 * forgotten but an absence of capability. It has **no demo guard**, and that is
 * deliberate: a platform rule that cannot be exercised in demo mode ships
 * unproven, and this half touches nothing a customer can see.
 *
 * **Act** — `applyInactivityDeactivation` — calls `patchObject(state: 'INACTIVE')`
 * and then writes the tracking row. It is refused while the tenant is in demo
 * mode, and the refusal is logged with the tenant, the reason and the number of
 * passes it chose not to touch. Not because Google forbids the write — writes work
 * in demo, which is why pass issuance runs there — but because a demo deployment
 * and a production deployment can share one database, so it cannot know whether
 * the rows in front of it belong to test accounts or to real customers, and
 * writing `inactive` for a real customer is the incident this whole feature is
 * built to avoid.
 *
 * ## Why not the sweep
 *
 * `runScheduledSweep` refuses to run in demo mode, and for a good reason: it is a
 * background writer with no Google publishing access behind it. Hooking this rule
 * onto it would inherit that refusal and **never run at all**, in any
 * environment. So this rule has its own entry point, dispatched from
 * `workers/automation` beside the sweep rather than inside it.
 *
 * ## What this does not do
 *
 * It does not send a notification, does not change the ledger, does not touch
 * `points_expiry_days`, and does not decide anything about points. Expiring a
 * balance and deactivating a card are different rules with similar names; see the
 * migration for why they are not the same column.
 */

import type { GoogleWalletClient } from './google-client';
import { normaliseGoogleObjectState, type GoogleObjectState } from './object';
import type { InactivityCandidateRow, WalletStore } from './store';

// ---------------------------------------------------------------------------
// The state this rule writes
// ---------------------------------------------------------------------------

/**
 * The local tracking state, and Google's state, this rule writes.
 *
 * Exported as a constant rather than repeated as a literal so the string in the
 * log, the string in the report and the string in the write cannot drift apart.
 * `inactive` is the only reversible choice — see the module comment.
 */
export const INACTIVITY_STATE = 'inactive' as const;

/**
 * The minimum window a tenant may configure.
 *
 * Not a recommendation — a lower bound. A `0` or a negative number that reached
 * the cutoff maths would make every pass in the tenant a candidate on the next
 * run, which is the one outcome the nullability of the column exists to prevent
 * and the one a hand-edited row must not be able to cause either.
 */
export const MIN_INACTIVITY_MONTHS = 1;

/**
 * Candidates fetched per tenant per run.
 *
 * A hard bound, honoured by the store, for the same reason the sweep's
 * per-tenant budgets exist: an invocation must not be able to read an unbounded
 * number of rows, and a report has to be able to say how much it did not reach.
 * Truncation is reported (`tenantsTruncated`) rather than applied silently.
 */
export const MAX_CANDIDATES_PER_TENANT = 500;

/**
 * Tenants walked per page, and the bound on the number of pages one run reads.
 *
 * `listProgramTenants` is keyset-paginated, so the enumeration is resumable and a
 * tenant inserted mid-walk shifts nothing. `MAX_TENANT_PAGES` is what stops a
 * system with more configured tenants than one run reaches from spinning here
 * forever; the next run picks up where this one stopped.
 */
export const INACTIVITY_TENANT_PAGE = 200;
export const MAX_TENANT_PAGES = 25;

// ---------------------------------------------------------------------------
// The two pure predicates
// ---------------------------------------------------------------------------

/**
 * The instant before which a movement counts as inactivity.
 *
 * **Calendar months, not 30-day blocks, and clamped rather than rolled over.**
 *
 * Both halves of that sentence were arrived at the hard way. `now - 30 * n * DAY`
 * answers "30 days ago" for a question about months, which is wrong in every
 * short month and by a growing margin as `n` rises. And the obvious fix,
 * `date.setUTCMonth(date.getUTCMonth() - n)`, is **worse**: JS rolls the day
 * over instead of clamping it, so `2026-03-31` minus one month is `2026-03-03`
 * and `2026-01-31` minus one month is `2025-12-31`. Both are *later* than the
 * month a merchant named, which for the first is later by three weeks — a
 * customer at 89 days would be caught by a three-month rule on day 89.
 *
 * So the month is moved on the 1st, and the day is then clamped to the last day
 * of the month that results: `2026-03-31` minus one month is `2026-02-28`,
 * which is what a person means.
 *
 * The result is never after `now` for any window of a month or more, because the
 * target month index is strictly smaller and the day is only ever clamped down.
 * A cutoff in the future would be the worst possible input: every pass in the
 * tenant becomes a candidate on sight.
 *
 * @throws {RangeError} for a window below `MIN_INACTIVITY_MONTHS`. Throwing
 * rather than clamping, because a clamped `0` would silently become one month
 * and a merchant who wrote `0` would get a rule they did not ask for.
 */
export function inactivityCutoff(now: Date, months: number): Date {
  if (!Number.isFinite(months) || months < MIN_INACTIVITY_MONTHS) {
    throw new RangeError(
      `The pass inactivity window must be at least ${MIN_INACTIVITY_MONTHS} month(s), got ${months}. ` +
        'A window of 0 or less would deactivate every pass in the tenant on the next run.',
    );
  }

  const window = Math.trunc(months);
  const monthIndex = now.getUTCMonth();
  const day = now.getUTCDate();

  // Borrowed rather than truncated, so `2026-01` minus one month lands in the
  // previous year and a 24-month window from March lands in March two years
  // back. `%` in JS keeps the sign of the dividend, hence the `+ 12) % 12`.
  const targetYear = now.getUTCFullYear() + Math.floor((monthIndex - window) / 12);
  const targetMonth = (((monthIndex - window) % 12) + 12) % 12;

  // Day `0` of the following month *is* the last day of the target month.
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

  // Same time of day, so the boundary a customer is compared against does not
  // drift by the hours between the run and the day's start.
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(day, lastDayOfTargetMonth),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

/**
 * Is this customer past the window?
 *
 * ## The comparison, stated once so it cannot be re-decided elsewhere
 *
 * `lastActivity < cutoff`, **strict**. Activity *at* the cutoff is inside the
 * window, so the customer is not a candidate. `store.ts`'s
 * `findInactivePassCandidates` mirrors this in SQL; that mirror is the one place
 * the two must agree, and it is asserted by tests in both places.
 *
 * ## The enrolment clock
 *
 * A customer who has never transacted has no activity to measure, and treating
 * "no data" as "infinitely inactive" would make the first run of this rule mute
 * every customer who enrolled that week. Their clock is `customers.created_at`,
 * so they become a candidate only after X months of *existing*.
 *
 * The same strict comparison applies to that fallback, so a customer enrolled
 * exactly on the cutoff is still inside their own window.
 *
 * @param lastActivityAt Latest `points_transactions.created_at`, or `null` for a
 *   customer who has never transacted.
 * @param enrolledAt `customers.created_at`. The clock for the no-activity case.
 * @param cutoff From `inactivityCutoff`.
 */
export function isInactiveSince(
  lastActivityAt: Date | null,
  enrolledAt: Date,
  cutoff: Date,
): boolean {
  const clock = lastActivityAt ?? enrolledAt;
  return clock.getTime() < cutoff.getTime();
}

/**
 * Is this tenant's rule configured?
 *
 * `null`, `undefined` and anything below `MIN_INACTIVITY_MONTHS` are all "off".
 *
 * `null`/`undefined` is the migration's stated meaning, and the two non-positive
 * numbers are a guard against a hand-edited or mis-migrated row: a column that
 * only `NULL` protects is one bad `UPDATE` away from deactivating a whole
 * merchant's customer base. Failing closed here costs a tenant that meant to
 * configure a window nothing, and failing open costs them their cards.
 */
export function inactivityWindowFor(passInactivityMonths: number | null | undefined): number | null {
  if (passInactivityMonths === null || passInactivityMonths === undefined) return null;
  if (!Number.isFinite(passInactivityMonths)) return null;
  if (Math.trunc(passInactivityMonths) < MIN_INACTIVITY_MONTHS) return null;
  return Math.trunc(passInactivityMonths);
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface InactivityTenantPlan {
  tenantId: string;
  /** The tenant's own window, in months. */
  months: number;
  cutoff: Date;
  candidates: InactivityCandidateRow[];
  /** Whether the candidate bound cut this tenant short this run. */
  truncated: boolean;
}

export interface InactivityPlan {
  /** Tenants with a wallet program row, whatever their configuration. */
  tenantsConsidered: number;
  /** Tenants with a usable window, which is where the work happens. */
  tenantsConfigured: number;
  /** Tenants considered and deliberately left alone. */
  tenantsDisabled: number;
  tenants: InactivityTenantPlan[];
  totalCandidates: number;
  /** Tenants whose candidate list was cut short by the bound. */
  tenantsTruncated: number;
}

export interface InactivityPlanDeps {
  store: WalletStore;
  /** The clock. A parameter so no assertion depends on the wall. */
  now?: () => Date;
}

/**
 * Decide. Read-only, and read-only **by construction**.
 *
 * ## Why there is no `client` in these dependencies
 *
 * Not oversight and not a missed parameter: the plan cannot write to Google
 * because it has no way to name Google. A dry run behind a boolean flag is a dry
 * run that writes the day somebody forgets the flag, and the flag would live one
 * branch away from a call site that matters.
 *
 * ## What it reports
 *
 * Per tenant: the window, the cutoff it derived, and every pass that window
 * selects. The count is the number a human needs before running this for real,
 * which is why it is a report rather than a boolean.
 *
 * ## Why it has no demo guard
 *
 * Decision 3 for this feature. Every statement here is local, and the local data
 * is not more sensitive in a demo environment than in production — it is the same
 * database. A platform rule whose decide half cannot be exercised in demo is a
 * rule whose *only* exercise is its first run against real customers.
 */
export async function planInactivityDeactivation(
  deps: InactivityPlanDeps,
): Promise<InactivityPlan> {
  const now = deps.now?.() ?? new Date();

  const plan: InactivityPlan = {
    tenantsConsidered: 0,
    tenantsConfigured: 0,
    tenantsDisabled: 0,
    tenants: [],
    totalCandidates: 0,
    tenantsTruncated: 0,
  };

  let cursor: string | null = null;

  for (let page = 0; page < MAX_TENANT_PAGES; page += 1) {
    const programs = await deps.store.listProgramTenants({
      limit: INACTIVITY_TENANT_PAGE,
      afterTenantId: cursor,
    });

    // An empty page ends the enumeration. This is checked before the cursor is
    // advanced so a page that returns fewer rows than the bound cannot loop.
    if (programs.length === 0) break;

    for (const program of programs) {
      plan.tenantsConsidered += 1;

      const months = inactivityWindowFor(program.passInactivityMonths);
      if (months === null) {
        // Not a warning and not a failure. "This tenant has not asked for this
        // rule" is the expected state for every tenant that has not, which is
        // all of them until somebody writes a number into the column.
        plan.tenantsDisabled += 1;
        continue;
      }

      const cutoff = inactivityCutoff(now, months);
      const candidates = await deps.store.findInactivePassCandidates({
        tenantId: program.tenantId,
        cutoff,
        limit: MAX_CANDIDATES_PER_TENANT,
      });

      // One past the bound is the only way to tell "exactly at the bound" from
      // "cut short", and the extra row is dropped rather than reported: it was
      // not selected.
      const truncated = candidates.length > MAX_CANDIDATES_PER_TENANT;
      const selected = truncated ? candidates.slice(0, MAX_CANDIDATES_PER_TENANT) : candidates;

      plan.tenantsConfigured += 1;
      plan.tenants.push({ tenantId: program.tenantId, months, cutoff, candidates: selected, truncated });
      plan.totalCandidates += selected.length;
      if (truncated) plan.tenantsTruncated += 1;
    }

    // The keyset cursor is the last row's own key, not the page length, so a
    // tenant that vanished mid-walk cannot make the walk restart.
    cursor = programs[programs.length - 1].tenantId;

    if (programs.length < INACTIVITY_TENANT_PAGE) break;
  }

  // Logged by the plan, not by whoever called it, so the dry run describes
  // itself. That is the whole value of a dry run: an operator has to be able to
  // read "tenant X, 3 months, 400 passes" without a second tool.
  for (const tenant of plan.tenants) {
    logTenantPlan(tenant);
  }

  return plan;
}

// ---------------------------------------------------------------------------
// The act
// ---------------------------------------------------------------------------

export type InactivityFailureStage = 'google_patch' | 'local_write';

export interface InactivityFailure {
  tenantId: string;
  customerId: string;
  objectId: string;
  stage: InactivityFailureStage;
  reason: string;
}

export interface InactivityActSummary {
  /** Tenants whose passes were actually pushed to `INACTIVE`. */
  tenantsActed: number;
  /**
   * Tenants this rule selected passes for and refused to act on because demo
   * mode holds the deployment or the tenant row.
   *
   * Its own counter rather than a folded-in failure, because nothing about
   * waiting changes it and reporting it as a failure would train a support
   * reader to ignore failures.
   */
  tenantsSkippedNotWritable: number;
  /** Passes Google confirmed as `INACTIVE` **and** our row recorded. */
  passesDeactivated: number;
  googlePatchFailures: number;
  /**
   * Google confirmed the patch and our `UPDATE` matched no row.
   *
   * Not a failure: it means the pass was reactivated or removed between being
   * selected and being written. Counted separately so a guard that refuses a
   * write is distinguishable from a write that never happened.
   */
  localWritesSkipped: number;
  failures: InactivityFailure[];
}

export interface InactivityApplyReport extends InactivityPlan {
  /** Whether demo mode is in force for this deployment. */
  demoMode: boolean;
  acted: InactivityActSummary;
}

export interface InactivityApplyDeps extends InactivityPlanDeps {
  client: GoogleWalletClient;
  /**
   * The deployment-wide ceiling. `true` refuses every tenant; the tenant's own
   * `demoMode` column refuses that tenant. Same `env || row` combination
   * `classReadinessFor` uses, deliberately, so "may this worker act on this
   * merchant's wallet" has one answer in this worker rather than two.
   */
  demoMode: boolean;
}

/**
 * Decide, then act.
 *
 * ## The order, and what each step is allowed to conclude
 *
 * 1. `planInactivityDeactivation` — the same function, the same query, the same
   *    numbers the dry run printed. There is one decision path; a second
 *    implementation of "who is inactive" is exactly the drift that produces a
 *    report nobody can reconcile with what happened.
 * 2. For each tenant, ask whether we may write at all. Demo mode says no.
 * 3. For each candidate, `patchObject(state: 'INACTIVE')`. **Google first.** A
 *    throw or a non-`INACTIVE` echo leaves the tracking row untouched: a local
 *    state that claims something Google did not say is the documented
 *    callback-module failure, and it is the one thing this rule must never
 *    produce.
 * 4. `recordPassLifecycle`, whose source set is `('issued', 'inactive')` and
 *    whose return value is how many rows it actually changed. Zero is counted,
 *    not treated as success.
 *
 * ## Why the patch is verified rather than assumed
 *
 * Google echoes the stored resource on a patch, so the response is a free
 * confirmation. `reconcile.ts` already depends on this for balances
 * (`PassPatchNotAppliedError`). Checking the echoed state is what makes step 4
 * safe to reach at all.
 *
 * ## One failure does not end the run
 *
 * A customer that cannot be patched is retried on the next run, and the other
 * customers in that tenant are not held up by it. The report carries the failure
 * with its tenant and customer so it can be attributed.
 */
export async function applyInactivityDeactivation(
  deps: InactivityApplyDeps,
): Promise<InactivityApplyReport> {
  const now = deps.now?.() ?? new Date();
  const plan = await planInactivityDeactivation(deps);

  const acted: InactivityActSummary = {
    tenantsActed: 0,
    tenantsSkippedNotWritable: 0,
    passesDeactivated: 0,
    googlePatchFailures: 0,
    localWritesSkipped: 0,
    failures: [],
  };

  // Per tenant, not per deployment: one merchant held in demo mode must not mute
  // another merchant's rule, and a deployment with publishing access must still
  // act for the tenants whose rows say so.
  const programs = new Map(
    (await deps.store.listProgramTenants({ limit: INACTIVITY_TENANT_PAGE, afterTenantId: null })).map(
      (row) => [row.tenantId, row],
    ),
  );

  for (const tenant of plan.tenants) {
    const program = programs.get(tenant.tenantId);

    // Absent or unreadable means demo mode, which is the direction
    // `classReadinessFor` already chooses: a row that cannot say must not be
    // read as "this deployment may act".
    const demoForTenant = deps.demoMode || program?.demoMode !== false;

    if (demoForTenant) {
      acted.tenantsSkippedNotWritable += 1;
      // Explicit, and carrying the number it chose not to act on. A reader of a
      // run that selected 400 passes and touched none must be able to find out
      // that was the rule rather than a crash.
      console.log(
        `[wallet] Pass inactivity: tenant ${tenant.tenantId} was not acted on. This deployment or ` +
          `this tenant is in demo mode, so ${tenant.candidates.length} pass(es) selected by a ` +
          `${tenant.months}-month window were left as they are. Demo mode does not mean Google ` +
          'refuses the write — issuance runs there today — it means this deployment cannot tell ' +
          'test accounts from real customers, so it does not move real cards. Set ' +
          'WALLET_DEMO_MODE=false and the tenant\'s demo_mode to false to act.',
      );
      continue;
    }

    acted.tenantsActed += 1;

    for (const candidate of tenant.candidates) {
      try {
        const patched = await deps.client.patchObject(candidate.objectId, {
          state: 'INACTIVE',
        });

        // Post-condition, not optimism. An echo that is not `INACTIVE` means the
        // patch did not land, and writing our row anyway would put our database
        // in disagreement with Google over a real customer's card.
        //
        // `normaliseGoogleObjectState` takes the raw **state**, not the object,
        // and returns `null` for anything it does not recognise — so an
        // unfamiliar state is a refusal, not an accidental pass.
        const applied = normaliseGoogleObjectState(patched?.state);
        if (applied !== 'INACTIVE') {
          throw new Error(
            `Google echoed state "${String(patched?.state)}" for object ${candidate.objectId} ` +
              'after a patch that asked for INACTIVE, so the patch did not apply.',
          );
        }

        const rowsChanged = await deps.store.recordPassLifecycle({
          tenantId: tenant.tenantId,
          customerId: candidate.customerId,
          state: INACTIVITY_STATE,
          observedAt: now,
        });

        if (rowsChanged === 0) {
          // Google holds an `INACTIVE` object and our row says something else.
          // A method that reports success having changed nothing is how a report
          // stops being evidence, so it is its own counter.
          acted.localWritesSkipped += 1;
          acted.failures.push({
            tenantId: tenant.tenantId,
            customerId: candidate.customerId,
            objectId: candidate.objectId,
            stage: 'local_write',
            reason:
              'Google confirmed the object as INACTIVE but the local pass row matched no write ' +
              '(its state was no longer "issued").',
          });
          continue;
        }

        acted.passesDeactivated += 1;
      } catch (err: unknown) {
        // The tracking row is deliberately untouched on this path. Our row must
        // never claim a Google state that Google refused to confirm.
        acted.googlePatchFailures += 1;
        acted.failures.push({
          tenantId: tenant.tenantId,
          customerId: candidate.customerId,
          objectId: candidate.objectId,
          stage: 'google_patch',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  logSummary(plan, acted, deps.demoMode);

  return { ...plan, demoMode: deps.demoMode, acted };
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

/**
 * One line per tenant: the window, the cutoff it derived, and how many passes it
 * selected.
 *
 * This is the "how many it would touch" half of the pair the brief asks for, and
 * it is emitted by `planInactivityDeactivation` so it appears in a dry run, which
 * is the invocation that most needs to be self-describing. The matching "how many
 * it did" is the run summary below, and the two are printed by the same process
 * in the same run, so they cannot be read as coming from different data.
 */
function logTenantPlan(tenant: InactivityTenantPlan): void {
  console.log(
    `[wallet] Pass inactivity: tenant ${tenant.tenantId}, window ` +
      `${tenant.months} month${tenant.months === 1 ? '' : 's'}, ` +
      `cutoff ${tenant.cutoff.toISOString()}, ${tenant.candidates.length} pass(es) with no ` +
      `activity inside the window${tenant.truncated ? ' (list truncated by the per-run bound)' : ''}.`,
  );
}

function logSummary(
  plan: InactivityPlan,
  acted: InactivityActSummary,
  demoMode: boolean,
): void {
  console.log(
    `[wallet] Pass inactivity run: ${plan.tenantsConsidered} tenant(s) considered, ` +
      `${plan.tenantsConfigured} configured, ${plan.tenantsDisabled} not configured, ` +
      `${plan.totalCandidates} pass(es) selected, ${acted.passesDeactivated} deactivated, ` +
      `${acted.googlePatchFailures} Google patch failure(s), ${acted.localWritesSkipped} local ` +
      `write(s) refused, ${acted.tenantsSkippedNotWritable} tenant(s) not acted on` +
      `${demoMode ? ' (deployment is in demo mode)' : ''}, ${plan.tenantsTruncated} tenant(s) ` +
      `truncated, ${acted.failures.length} failure(s).`,
  );
}

// ---------------------------------------------------------------------------
// Re-exported for the store's contract tests
// ---------------------------------------------------------------------------

export type { GoogleObjectState };
