/**
 * Pass reconciliation: learning that a pass was saved, and keeping its balance
 * equal to the ledger's.
 *
 * ## The design question this file answers
 *
 * **How do we learn the pass was saved?** By asking Google, and only Google.
 * Google creates the `LoyaltyObject` server-side when a customer saves the pass,
 * so the object's existence *is* the signal: a `200` from
 * `GET /v1/loyaltyobject/{id}` means the customer saved it, and a `404` means
 * they have not. Nothing is inferred from the fact that we handed out a link.
 *
 * There is no other way to learn it. The `loyaltyobject` resource has no
 * subscribe, watch or callback method — the whole surface is `get`, `list`,
 * `insert`, `patch`, `update` and `addMessage` — so the issuer is never told.
 * The only options are polling Google, or having Google poll something of ours,
 * and the second is not a thing this API offers.
 *
 * @see https://developers.google.com/wallet/reference/rest/v1/loyaltyobject
 *
 * ## When is a new balance pushed?
 *
 * On the same request that observed the object, and only if the number Google
 * holds differs from the number the ledger holds. Google documents the same
 * order: "Before making a `patch` request, consider optionally sending a `GET`
 * request to compare your changes against the latest version."
 *
 * @see https://developers.google.com/wallet/retail/loyalty-cards/use-cases/updates
 *
 * ## Why not push on write, through the event bus
 *
 * Three reasons, in order of how much they matter.
 *
 * 1. **It does not answer the question.** A `PointsAssigned` event fires when
 *    points change. The customer may never have saved their pass, in which case
 *    there is no Google object and the handler has to `getObject` before it can
 *    discover that. Push-on-write does not remove the read; it adds a second
 *    code path that also has to do it, and two paths that must agree about when
 *    a pass exists.
 * 2. **It spends Google's write budget on passes nobody can see.** A busy
 *    tenant earning points on every purchase would produce a `patch` per
 *    purchase per customer, most of them for objects that do not exist and
 *    404. Google also caps field-update notifications at three per pass per 24
 *    hours, and `notifyPreference` is transient — it has to be set on each
 *    request or no notification fires. Unconditional patching is how a
 *    misconfigured integration starts earning quota errors.
 * 3. **It is not idempotent under at-least-once delivery.** The event bus
 *    documents at-least-once delivery and retries a throwing handler, so a push
 *    handler that patches on every event re-patches on every retry.
 *    Reconciliation compares first, so a duplicate delivery is a no-op.
 *
 * What would have to be true to choose it: publishing access granted, so objects
 * exist at all; measured quota headroom against a real tenant's event volume;
 * a `queue` consumer on this worker, which today exports `fetch` only; and a
 * decision about `PointsAssigned.payload.customer_id`, which the growth worker
 * reads as the internal id in one handler and the global id in the other. The
 * honest answer is that this is a **latency** optimisation, not a correctness
 * fix, and correctness is what is missing.
 *
 * The likely third option, and the one to reach for first if the latency ever
 * does matter, is Google's own suggestion: a scheduled sweep using
 * `loyaltyobject.list` per issuer, patching only the objects whose balance
 * differs. It covers customers who never open the app, costs one list call per
 * tenant instead of one per points event, and needs no new event type.
 */

import { balanceDisplayFailure, formatBalance } from './balance';
import type { GoogleWalletClient } from './google-client';
import { classReadinessFor, reasonCodeFor } from './issuance';
import type { WalletUnavailableReason } from './issuance';
import { normaliseGoogleObjectState, type LoyaltyObject, type PushNotification } from './object';
import type { ReconciliationState, WalletStore } from './store';

// ---------------------------------------------------------------------------
// Deps and input
// ---------------------------------------------------------------------------

export interface ReconcileDeps {
  store: WalletStore;
  /**
   * The Google Wallet client. Injected rather than constructed from bindings, so
   * this whole file is exercisable without a credential, a socket or a clock
   * that is not ours.
   */
  client: GoogleWalletClient;
  /**
   * Clock injection, so `last_synced_at` is assertable. Defaults to the system
   * clock. `Date | undefined` rather than `Date` because
   * `exactOptionalPropertyTypes` is on in this repository.
   */
  now?: Date | undefined;
  /**
   * The deployment-wide demo mode, from `WALLET_DEMO_MODE`.
   *
   * Required rather than defaulted, and injected alongside the client and the
   * clock so the whole path is exercisable without a credential or an
   * environment.
   *
   * **It no longer decides whether a class is usable.** That is
   * `classReadinessFor`'s question, and it is answered by `reviewStatus` and by
   * whether the class id carries Google's demo marker. This flag answers *who
   * receives the pass*, and it is threaded in rather than read here so the
   * deployment fact stays in one place — but the gate deliberately ignores it,
   * because a global `WALLET_DEMO_MODE=true` would otherwise put every unapproved
   * class back through and hand it a Google 404.
   */
  demoMode: boolean;
}

export interface ReconcileInput {
  /** `X-Business-Id`. The only tenant this call may touch. */
  tenantId: string;
  /** `customers.id`, resolved from the token within `tenantId`. */
  customerId: string;
}

/**
 * What a reconciliation actually did.
 *
 * A union rather than a boolean, because the interesting outcomes are the ones
 * where nothing was written and a caller needs to know *which* nothing. Every
 * branch that is not `patched` or `in_sync` left Google's object untouched.
 */
export type ReconcileOutcome =
  /**
   * The tenant's class cannot back a pass, so nothing was asked of Google and
   * nothing was written. Carries the same reason code the pass route would have
   * used, so a caller does not have to re-derive the vocabulary.
   */
  | { kind: 'skipped'; reason: WalletUnavailableReason; reasonCode: string }
  /**
   * There is no pass row for this customer, so there is no recorded
   * `object_id` to reconcile. An impossible outcome on the pass route, which
   * records the row first, and a real one for any other caller.
   */
  | { kind: 'no_tracking_row' }
  /**
   * The balance cannot be rendered in the primary balance row, so no number was
   * pushed. A pass that already exists keeps the last value that *was*
   * displayable rather than being given a truncated one.
   */
  | { kind: 'balance_not_displayable'; points: number }
  /** Google's answer did not let us act: no program row, or no currency. */
  | { kind: 'skipped_reason'; reason: 'program_not_configured' }
  /**
   * The object exists but Google reports it as something other than `ACTIVE`.
   *
   * No balance is pushed — a pass nobody is looking at is not "in sync" with
   * anything, and this system has no honest tracking state for a non-`ACTIVE`
   * object, so `state` is deliberately left alone.
   *
   * `observationRecorded` is whether the timestamp write actually changed a row.
   * It is `false` only when the row vanished between the read above and the
   * write, which is rare and permanent: a pass whose observation cannot be
   * recorded is still in the due set on the next run, so a caller that is
   * tracking liveness needs to see the difference between "verified, and nothing
   * to claim" and "believed verified".
   */
  | { kind: 'object_not_active'; state: string; observationRecorded: boolean }
  /** Google has no object for this customer yet. Recorded as `not_saved`. */
  | { kind: 'not_saved'; objectId: string }
  /** The object exists, is active, and already showed the ledger's balance. */
  | { kind: 'in_sync'; objectId: string }
  /** The object existed and was patched to the ledger's balance. */
  | { kind: 'patched'; objectId: string; balancePoints: number };

/** Thrown when Google accepted a patch that did not carry the number we sent. */
export class PassPatchNotAppliedError extends Error {
  readonly objectId: string;
  readonly expected: string;
  readonly received: string | null;

  constructor(objectId: string, expected: string, received: string | null) {
    super(
      `Google accepted a patch of ${objectId} but the object it returned shows balance ` +
        `${JSON.stringify(received)} rather than the ${JSON.stringify(expected)} that was sent. ` +
        'The pass is recorded as reconciled only when the number provably arrived, so this is ' +
        'raised rather than swallowed: a silently wrong number on a real pass is a support ' +
        'incident and a trust problem at the till.',
    );
    this.name = 'PassPatchNotAppliedError';
    this.objectId = objectId;
    this.expected = expected;
    this.received = received;
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Bring one customer's Google pass back into agreement with the ledger, and
 * record what Google said.
 *
 * ## The order the checks run in, and why
 *
 * 1. **Class readiness.** Nothing is asked of Google and nothing is written for
 *    a tenant whose class is not `approved`. Reusing `classReadinessFor` rather
 *    than re-deriving is the point: the pass route already runs it, and a second
 *    implementation of "is this class usable" is a second answer to a
 *    security- and cost-relevant question.
 * 2. **The tracking row.** Reconciliation acts on the `object_id` we recorded,
 *    not one derived again. A missing row stops it.
 * 3. **The ledger.** Read, never computed, and read *after* the row so a
 *    customer with no pass costs no ledger query.
 * 4. **The observation.** One `getObject`. This is both the existence signal and
 *    the value to compare against, so existence and idempotency cost one round
 *    trip together rather than two.
 * 5. **The comparison**, and only then the patch.
 *
 * ## Idempotency
 *
 * The gate is step 5: the patch happens **only** when Google's balance string
 * differs from the ledger's. A second call with an unchanged ledger balance
 * therefore issues no write to Google — the same balance string is found, the
 * comparison is equal, and the method returns `in_sync`. The `getObject` is a
 * read and is not a write. This is Google's documented guidance rather than an
 * invention, and it is also what makes a retried request safe.
 *
 * ## The patch is the balance, and only the balance
 *
 * `loyaltyPoints` is sent with its `label` as well as its `balance`, because
 * `label` is a required field of that sub-object and the patch has to be the
 * same projection the object was built from at issue time — a patch that
 * disagreed with the issued shape would be a second definition of the pass.
 * Nothing else is sent:
 *
 * - `accountName`, `barcode` and `textModulesData` are omitted so Google's
 *   patch semantics leave them alone. This matters more than it looks: Google
 *   documents that patching an array **replaces** it wholesale, so a patch that
 *   rebuilt `textModulesData` would drop the tier row rather than refresh it.
 * - `state` is omitted, so reconciliation can never activate, deactivate or
 *   expire a pass. It is a balance projection, not a lifecycle controller.
 */
export async function reconcilePass(
  deps: ReconcileDeps,
  input: ReconcileInput,
): Promise<ReconcileOutcome> {
  const { store, client } = deps;
  const observedAt = deps.now ?? new Date();

  const readiness = classReadinessFor(
    await store.findProgram(input.tenantId),
    input.tenantId,
    deps.demoMode,
  );
  if (!readiness.ok) {
    return { kind: 'skipped', reason: readiness.reason, reasonCode: reasonCodeFor(readiness.reason) };
  }

  const pass = await store.findPass(input.customerId, input.tenantId);
  if (pass === null) {
    return { kind: 'no_tracking_row' };
  }

  // Read, never computed. The single most damaging edit to this file would be a
  // "helpful" delta applied to the last pushed number.
  const balancePoints = await store.latestBalance(input.customerId, input.tenantId);

  // The observation. A 404 is a real answer, not a failure: Google creates the
  // object when the customer saves the pass, so its absence means exactly that
  // the customer has not saved it yet.
  const remote = await client.getObject(pass.objectId);

  if (remote === null) {
    await recordReconciliation(deps, input, 'not_saved', observedAt);
    return { kind: 'not_saved', objectId: pass.objectId };
  }

  // Google's own word for the state, never a case-sensitive comparison against
  // the enum's spelling. A literal `!== 'ACTIVE'` reads every real response as
  // inactive, because Google answers `"active"`, and the result is a pass that
  // records an observation and never takes the patch.
  const remoteState = normaliseGoogleObjectState(remote.state);

  if (remoteState !== 'ACTIVE') {
    // The object exists and Google says it is not `ACTIVE`. That is a
    // definitive answer, so it is recorded — as an observation only, with no
    // state, because there is no tracking state that honestly means "not
    // active". See `recordPassObservation` for why leaving the timestamp alone
    // was a liveness bug and not restraint: the pass then never left the sweep's
    // due set, and a tenant holding enough of them starved outright.
    const rowsChanged = await recordObservation(deps, input, observedAt);
    return { kind: 'object_not_active', state: String(remote.state), observationRecorded: rowsChanged > 0 };
  }

  // Checked before touching Google, because a balance we cannot render is a
  // balance we refuse to send. `balanceDisplayFailure` is the same predicate
  // `formatBalance` throws on, so the two cannot disagree about the ceiling.
  if (balanceDisplayFailure(balancePoints) !== null) {
    return { kind: 'balance_not_displayable', points: balancePoints };
  }

  const nextBalance = formatBalance(balancePoints);
  const currentBalance = balanceStringOf(remote);

  if (currentBalance === nextBalance) {
    // The idempotency gate. Nothing is written to Google here, and the tracking
    // row is still refreshed because Google did give a definitive answer.
    await recordReconciliation(deps, input, 'issued', observedAt);
    return { kind: 'in_sync', objectId: pass.objectId };
  }

  const pointsCurrency = await store.findPointsCurrency(input.tenantId);
  if (pointsCurrency === null) {
    // The pass exists at Google and this tenant has no currency to label a
    // balance with. Stopping is the same choice `issuePass` makes: an invented
    // currency on a real pass is a lie the member reads at the till.
    return { kind: 'skipped_reason', reason: 'program_not_configured' };
  }

  const patched = await client.patchObject(pass.objectId, {
    loyaltyPoints: { label: pointsCurrency, balance: { string: nextBalance } },
  });

  // Post-condition, not optimism. Google echoes the stored resource, so this is
  // a free confirmation that the number arrived, and it is the difference
  // between recording a pass as reconciled and recording a pass that is wrong.
  const applied = balanceStringOf(patched);
  if (applied !== nextBalance) {
    throw new PassPatchNotAppliedError(pass.objectId, nextBalance, applied);
  }

  await recordReconciliation(deps, input, 'issued', observedAt);
  return { kind: 'patched', objectId: pass.objectId, balancePoints };
}

/**
 * The balance string Google currently holds, or `null` when the object carries
 * none.
 *
 * `null` is treated as "differs from everything" rather than as an error: an
 * object with no `loyaltyPoints` at all is an object whose balance we have
 * certainly not projected onto, so the correct response is to send the balance,
 * not to shrug and record it as in sync.
 */
function balanceStringOf(object: LoyaltyObject | null): string | null {
  const balance = object?.loyaltyPoints?.balance?.string;
  return typeof balance === 'string' ? balance : null;
}

/** Record the observation. Isolated so every state write goes through one call. */
async function recordReconciliation(
  deps: ReconcileDeps,
  input: ReconcileInput,
  state: ReconciliationState,
  observedAt: Date,
): Promise<void> {
  await deps.store.recordPassReconciliation({
    customerId: input.customerId,
    tenantId: input.tenantId,
    state,
    observedAt,
  });
}

/**
 * Record a definitive answer that carries no state claim.
 *
 * Separate from `recordReconciliation` rather than a flag on it, so the two
 * cannot be confused at a call site: a `ReconciliationState` is a claim about
 * existence, and this is not one. It is the only path that leaves a pass in the
 * sweep's due set without writing something, so it is the one that has to be
 * visible in a return type.
 */
async function recordObservation(
  deps: ReconcileDeps,
  input: ReconcileInput,
  observedAt: Date,
): Promise<number> {
  return deps.store.recordPassObservation({
    customerId: input.customerId,
    tenantId: input.tenantId,
    observedAt,
  });
}

/**
 * Update push notifications on a customer's loyalty pass.
 *
 * This patches the LoyaltyObject at Google with new push notifications.
 * Returns true if the patch was applied, false if the object doesn't exist.
 */
export async function updatePassPushNotifications(
  deps: ReconcileDeps,
  input: ReconcileInput,
  notifications: PushNotification[],
): Promise<boolean> {
  const pass = await deps.store.findPass(input.tenantId, input.customerId);
  if (!pass || !pass.objectId) {
    return false;
  }

  const client = deps.client;
  const classId = pass.classId || deps.store.issuerId + ".tenant-" + input.tenantId;
  
  for (const notification of notifications) {
    const messageId = crypto.randomUUID();
    await client.addMessage(pass.objectId, classId, {
      header: notification.title,
      body: notification.body,
      id: messageId,
      messageType: 'TEXT_AND_NOTIFY',
      ...(notification.url ? { url: notification.url } : {}),
      ...(notification.offerId ? { offerId: notification.offerId } : {}),
    });
  }

  return true;
}
