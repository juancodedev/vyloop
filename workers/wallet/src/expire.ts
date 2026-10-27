/**
 * Expire a deleted customer's Google Wallet pass.
 *
 * ## Why this exists
 *
 * Deleting an account anonymises the customer in one database transaction, and
 * none of that reaches the phone: the pass a customer saved is a Google object
 * carrying their name in `accountName`, and Google keeps rendering it until it is
 * told otherwise. So the deletion is followed by one patch that sets the object
 * `EXPIRED` and clears the name — which is what "the name stops showing on the
 * phone" means in the design (`customer-profile-redesign`, "Account deletion
 * (Phase 5)").
 *
 * ## Two callers, one function
 *
 * The customer worker calls `expireCustomerPass` (in `index.ts`) under the
 * deletion's `waitUntil`, and the daily sweep calls this for every deleted
 * customer whose pass is not recorded `expired` yet. A failure on the first path
 * is logged and never rolled back, so the second path is the retry; both go
 * through this one function so the retry cannot drift from what the deletion
 * asked for — the same reason `reconcilePass` is shared by the pass route, the
 * push trigger and the sweep.
 *
 * ## What is recorded, and when
 *
 * The tracking row moves to `expired` only after Google has confirmed it, or
 * after Google answered `404` — an object that does not exist cannot show a name,
 * which is the outcome this was for. Any other failure leaves the row exactly as
 * it was, so the sweep finds it again tomorrow.
 */

import { GoogleWalletApiError } from './google-client';
import type { GoogleWalletClient, LoyaltyObjectPatch } from './google-client';
import { classReadinessFor, reasonCodeFor } from './issuance';
import type { WalletUnavailableReason } from './issuance';
import { normaliseGoogleObjectState } from './object';
import type { LoyaltyObject } from './object';
import type { WalletStore } from './store';

// ---------------------------------------------------------------------------
// Deps, input and outcome
// ---------------------------------------------------------------------------

export interface ExpireDeps {
  store: WalletStore;
  /** Injected, so the whole path is exercisable without a credential. */
  client: GoogleWalletClient;
  /** Clock injection, so `last_synced_at` is assertable. Defaults to now. */
  now?: Date | undefined;
  /**
   * The deployment-wide demo mode, threaded to `classReadinessFor` exactly as
   * `reconcilePass` threads it. See `ReconcileDeps.demoMode` for why the gate
   * deliberately ignores it in favour of what Google accepts.
   */
  demoMode: boolean;
}

export interface ExpireInput {
  /** The only tenant this call may touch. */
  tenantId: string;
  /** `customers.id`, of a customer already deleted. Not the token subject. */
  customerId: string;
}

export type ExpireOutcome =
  /**
   * The tenant's class cannot back a pass, so nothing was asked of Google. The
   * same refusal, with the same reason code, `reconcilePass` makes.
   */
  | { kind: 'skipped'; reason: WalletUnavailableReason; reasonCode: string }
  /**
   * There is nothing on a phone to expire. `no_tracking_row` covers both "this
   * customer never had a pass row" and "this customer is not deleted" — the read
   * cannot tell them apart, on purpose; see `findDeletedCustomerPass`.
   * `never_saved` is a row in `not_issued` or `not_saved`: no Google object.
   */
  | { kind: 'nothing_to_expire'; reason: 'no_tracking_row' | 'never_saved' }
  /** The row is already `expired`. Nothing was asked of Google. */
  | { kind: 'already_expired'; objectId: string }
  /**
   * Google confirmed the object `EXPIRED` with no name. `recorded` is whether
   * the tracking write changed a row; `false` means the row moved under us, and
   * the sweep will patch again (harmlessly) and record it then.
   */
  | { kind: 'expired'; objectId: string; recorded: boolean }
  /** Google answered `404`: no object, so no name. Recorded as `expired`. */
  | { kind: 'already_gone'; objectId: string; recorded: boolean }
  /**
   * Google, or the database, failed. The row is left as it was. `objectId` is
   * `null` when the failure came before the pass row was read.
   */
  | { kind: 'failed'; objectId: string | null; reason: string };

/**
 * The patch, exactly.
 *
 * `accountName: null` rather than `''`: Google's patch semantics clear a field
 * sent as JSON `null`, while an empty string is a value it would store. Nothing
 * else is sent — the balance, the member code and the barcode are not this
 * path's to decide, and the member code is meaningless once the customer row
 * has none.
 */
export const EXPIRED_PASS_PATCH: LoyaltyObjectPatch = Object.freeze({
  state: 'EXPIRED',
  accountName: null,
});

// ---------------------------------------------------------------------------
// The expiry
// ---------------------------------------------------------------------------

/**
 * Expire one deleted customer's pass.
 *
 * Google failures are returned as `failed`, never thrown: both callers would
 * only catch and log. A database failure is thrown, because a store that cannot
 * be read is the caller's to report — `expireCustomerPass` folds it into a
 * `failed` outcome for the service binding, and the sweep attributes it to the
 * tenant.
 */
export async function expirePass(deps: ExpireDeps, input: ExpireInput): Promise<ExpireOutcome> {
  const { store, client } = deps;
  const observedAt = deps.now ?? new Date();

  // The same gate, in the same position, as `reconcilePass`: no Google call for a
  // class Google will not accept objects for. A pass saved at Google implies the
  // class was usable once, so this is about a class that stopped being usable
  // since — and about not having a second answer to "may this worker write here".
  const readiness = classReadinessFor(
    await store.findProgram(input.tenantId),
    input.tenantId,
    deps.demoMode,
  );
  if (!readiness.ok) {
    return { kind: 'skipped', reason: readiness.reason, reasonCode: reasonCodeFor(readiness.reason) };
  }

  const pass = await store.findDeletedCustomerPass(input.customerId, input.tenantId);
  if (pass === null) {
    return { kind: 'nothing_to_expire', reason: 'no_tracking_row' };
  }

  if (pass.state === 'expired') {
    // The idempotency gate. A deletion retried, or a sweep reaching a pass the
    // deletion already expired, asks Google nothing.
    return { kind: 'already_expired', objectId: pass.objectId };
  }

  if (pass.state === 'not_issued' || pass.state === 'not_saved') {
    // No Google object exists, so there is no name on any phone. Nothing is
    // recorded: `expired` is a claim about an object, and this pass has none.
    return { kind: 'nothing_to_expire', reason: 'never_saved' };
  }

  let patched: LoyaltyObject;
  try {
    patched = await client.patchObject(pass.objectId, EXPIRED_PASS_PATCH);
  } catch (err: unknown) {
    if (err instanceof GoogleWalletApiError && err.status === 404) {
      const rows = await record(deps, input, observedAt);
      return { kind: 'already_gone', objectId: pass.objectId, recorded: rows > 0 };
    }
    return { kind: 'failed', objectId: pass.objectId, reason: describe(err) };
  }

  // Post-condition, as in `reconcilePass`: Google echoes the stored resource, so
  // the row is recorded `expired` only when the echo shows the state took and the
  // name is gone. A Google that accepted the patch and kept the name is a failure
  // the sweep should keep retrying, not a success to forget about.
  const applied = normaliseGoogleObjectState(patched.state) === 'EXPIRED';
  // `?? ''` covers absent and a `null` the wire may carry despite the type.
  const nameCleared = (patched.accountName ?? '') === '';
  if (!applied || !nameCleared) {
    return {
      kind: 'failed',
      objectId: pass.objectId,
      reason:
        `Google accepted the expiry of ${pass.objectId} but returned state ` +
        `${JSON.stringify(patched.state)}${nameCleared ? '' : ' with the name still on it'}.`,
    };
  }

  const rows = await record(deps, input, observedAt);
  return { kind: 'expired', objectId: pass.objectId, recorded: rows > 0 };
}

function record(deps: ExpireDeps, input: ExpireInput, observedAt: Date): Promise<number> {
  return deps.store.recordPassExpired({
    customerId: input.customerId,
    tenantId: input.tenantId,
    observedAt,
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
