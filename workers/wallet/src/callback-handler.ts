/**
 * Applying a Google Wallet callback: the rules, over a `WalletStore`.
 *
 * The cryptography is `callbacks.ts` and knows nothing about tenants. This file
 * is the other half: everything that has to be true before a **verified** Google
 * message is allowed to move a row. It is a plain function over a `WalletStore`
 * for the same reason `issuance.ts` is — the rules can be broken one at a time
 * without a database, and `routes.ts` does nothing but translate HTTP into a call
 * to this.
 *
 * ## The order, and it is not a style choice
 *
 * ```text
 * verify signature  →  resolve tenant from classId  →  claim the nonce
 *                  →  find the pass row              →  write
 * ```
 *
 * 1. **Signature first.** Nothing before it opens a database. An endpoint that
 *    verifies after touching the database has already done work on behalf of
 *    whoever sent the request.
 * 2. **The tenant is derived, never supplied.** The body carries a `classId`;
 *    the tenant comes from `tenant_wallet_programs`. There is no field, header
 *    or path segment a caller could use to name a tenant, so "may this callback
 *    touch that row" is answered by a lookup rather than by a check on input.
 * 3. **The nonce is claimed before the write.** Recording it afterwards would
 *    make this audited rather than idempotent, and a retry landing in between
 *    would apply twice.
 * 4. **The write is narrowed twice** — by `object_id` *and* by the resolved
 *    tenant, so a class belonging to one tenant cannot name a pass in another's
 *    rows even if `object_id` were not globally unique.
 *
 * ## What this never logs
 *
 * A callback body is not PII, but `objectId` is a **stable, tenant-scoped
 * customer identifier**: it embeds `customers.global_id`, which is what a support
 * ticket quotes. It appears in no log line, and neither does the nonce nor the
 * signature. `CallbackOutcome` deliberately carries no identifier at all — see
 * its note.
 */

import { PassCallbackVerificationError, passStateForEvent, verifyPassCallback } from './callbacks';
import type {
  GoogleCallbackRootKey,
  PassCallbackEvent,
  PassCallbackEventType,
  PassCallbackFailureCode,
  PassCallbackState,
} from './callbacks';
import type { WalletStore } from './store';

// ---------------------------------------------------------------------------
// Deps and outcome
// ---------------------------------------------------------------------------

export interface CallbackDeps {
  store: WalletStore;
  /**
   * The issuer id the signature is bound to — `GOOGLE_WALLET_ISSUER_ID`.
   *
   * Required, and never defaulted, because it is one of the three signed parts.
   * Without it there is nothing to verify against, and a verifier that skipped
   * the check would be the false confidence this whole path exists to avoid.
   */
  recipientId: string;
  /**
   * Injected so tests never reach Google's key service.
   *
   * Omitted in production, where the real cached fetch runs. `exactOptionalPropertyTypes`
   * is on in this repository, hence the conditional spread rather than
   * `fetchRootKeys: undefined`.
   */
  fetchRootKeys?: () => Promise<GoogleCallbackRootKey[]>;
  /** Injected clock, for both the expiry check and the observation stamp. */
  now?: () => Date;
}

/** Why a verified callback did not move a row. */
export type CallbackSkipReason =
  /** No `tenant_wallet_programs` row owns this `class_id`. */
  | 'unknown_class'
  /** This `nonce` was already applied. A Google retry. */
  | 'replay'
  /** No pass row for this `object_id` inside the resolved tenant. */
  | 'no_pass_row'
  /** The write matched no row — our tracking state and Google's disagree. */
  | 'state_write_refused';

export type CallbackOutcome =
  /** The pass state was written. `state` is the value written. */
  | { kind: 'applied'; eventType: PassCallbackEventType; state: PassCallbackState }
  /**
   * Verified, but nothing to do.
   *
   * `reason` only — no `classId`, `objectId` or `nonce`. The route needs a
   * reason to log and a count to increment; an identifier would tempt a future
   * edit to add one to a log line, and `objectId` embeds `customers.global_id`.
   * A support question about *which* pass needs the timestamp and the tenant,
   * not the pass id, and both of those are available from the request log.
   */
  | { kind: 'skipped'; reason: CallbackSkipReason }
  /**
   * Refused before it was authenticated, with the verification failure code.
   *
   * Kept distinct from `skipped` because a forgery and a benign retry deserve
   * different log lines: the first is an attack signal, the second is Google
   * being resilient.
   */
  | { kind: 'rejected'; code: PassCallbackFailureCode };

/**
 * What is left once the signature has been verified.
 *
 * `CallbackOutcome` minus `rejected`, which is the branch that only
 * `verifyPassCallback` can produce. Narrowing it here is not decoration: it is
 * what lets a caller that has *already* verified — the route, which must verify
 * before it can open a tenant-scoped session — handle the result without a
 * branch for an outcome it is incapable of returning.
 */
export type VerifiedCallbackOutcome = Exclude<CallbackOutcome, { kind: 'rejected' }>;

function skipped(reason: CallbackSkipReason): VerifiedCallbackOutcome {
  return { kind: 'skipped', reason };
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/**
 * Verify a callback body and apply it, or explain why not.
 *
 * The composition of the two halves below, and what the tests drive. The route
 * uses the halves individually — see its note on why — so this exists both as
 * the readable statement of the whole flow and as the seam the suite exercises.
 *
 * ## Never throws
 *
 * Every failure is an outcome, because the caller is an unauthenticated public
 * endpoint. A thrown error there becomes a 500, and **a 500 is the one answer
 * that makes Google retry a message which will never be valid** — an unbounded
 * retry loop against a message we can never accept. Which status to return is a
 * decision that belongs next to the rules, not scattered through a route.
 */
export async function handlePassCallback(
  deps: CallbackDeps,
  rawBody: string,
): Promise<CallbackOutcome> {
  let event: PassCallbackEvent;
  try {
    event = await verifyPassCallback(rawBody, {
      recipientId: deps.recipientId,
      ...(deps.fetchRootKeys === undefined ? {} : { fetchRootKeys: deps.fetchRootKeys }),
      ...(deps.now === undefined ? {} : { now: () => (deps.now as () => Date)().getTime() }),
    });
  } catch (err: unknown) {
    if (err instanceof PassCallbackVerificationError) {
      return { kind: 'rejected', code: err.code };
    }
    throw err;
  }

  return applyVerifiedCallback(deps, event);
}

/**
 * Everything that happens **after** the signature has been verified.
 *
 * ## Why this is a separate entry point
 *
 * The route needs the tenant before it can build a tenant-scoped store, and it
 * needs the tenant to come from the verified `classId` — so it must verify before
 * it can call anything here. Splitting the two lets the body be read and
 * verified exactly once, which is not a micro-optimisation: a `Request` body can
 * only be read once, so the two-halves arrangement is what makes a single read
 * possible at all.
 *
 * The alternative — resolving the tenant on an unverified body, then verifying —
 * would put a database read on the path of a forgery.
 *
 * ## `event` is trusted because only `verifyPassCallback` can produce one
 *
 * It is an exported function, so a future caller could hand this something
 * invented. That is why the parameter is named `verifiedEvent` and the type is
 * the narrow one: the next reader is told what they are holding.
 */
export async function applyVerifiedCallback(
  deps: CallbackDeps,
  verifiedEvent: PassCallbackEvent,
): Promise<VerifiedCallbackOutcome> {
  const { store } = deps;
  const event = verifiedEvent;
  const observedAt = deps.now?.() ?? new Date();

  // -- 1. The tenant comes from the class, never from the request ---------
  //
  // This is the tenant-isolation boundary in its entirety. A callback names a
  // Google class; the class names a tenant; the tenant scopes every read and
  // write below. An `objectId` that does not resolve *inside that tenant* is not
  // found, so a callback for tenant A's class cannot touch tenant B's row even
  // if the sender knows B's `objectId` — the row is simply not in scope.
  const owner = await store.findTenantByClassId(event.classId);
  if (owner === null) {
    return skipped('unknown_class');
  }
  const tenantId = owner.tenantId;

  // -- 2. Claim the nonce, before the write -------------------------------
  //
  // Ordering is the contract. A replay is caught here and stops, which is what
  // stops a second delivery of an old `save` resurrecting a pass a later `del`
  // already removed.
  const claimed = await store.claimCallbackDelivery({
    tenantId,
    nonce: event.nonce,
    eventType: event.eventType,
  });
  if (!claimed) {
    return skipped('replay');
  }

  // -- 3. Find the pass, within the resolved tenant ------------------------
  //
  // `findPassesByObjectIds` carries the tenant predicate itself, and reusing it
  // rather than adding a singular sibling means the filter is the one the sweep
  // already proves. `objectId` arrives from a request body, so it is a bound
  // parameter and never concatenated into SQL — quoted, not trusted.
  const [pass] = await store.findPassesByObjectIds([event.objectId], tenantId);
  if (pass === undefined) {
    return skipped('no_pass_row');
  }

  // -- 4. Write ------------------------------------------------------------
  const written = await store.recordPassCallback(
    { customerId: pass.customerId, tenantId, eventType: event.eventType },
    observedAt,
  );

  if (written === 0) {
    // Our tracking state and Google's disagree, or the row went away between the
    // read and the write. Reported rather than papered over: the sweep will read
    // this pass again and converge it, and an outcome claiming success here would
    // be a report that stopped being evidence.
    return skipped('state_write_refused');
  }

  return { kind: 'applied', eventType: event.eventType, state: passStateForEvent(event.eventType) };
}
