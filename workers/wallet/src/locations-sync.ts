/**
 * Keeping a pass's `merchantLocations` in step with consent and with the
 * business's venues.
 *
 * ## Why this is not part of `reconcile.ts`
 *
 * Reconciliation projects the **ledger** onto the pass: it reads a balance and
 * writes it. This projects a **catalogue**: which venues exist, where they are,
 * and whether this customer agreed to be found. The two share a Google client
 * and nothing else, and folding them together would give the sweep permission to
 * write locations — a consent-bearing field — as a side effect of a balance
 * update.
 *
 * ## Why an empty list is sent rather than omitted
 *
 * `buildLoyaltyObject` omits the field when there is nothing to carry, because
 * an issuance payload should not claim a consent the customer never gave. A
 * **patch** is the opposite operation: its job is to make Google match us, and a
 * withdrawal is expressed as "now there are none". Omitting the field from a
 * patch that exists only to clear it is the one way to make a revocation
 * silently fail, so the array is always present, `[]` included.
 *
 * JSON merge-patch semantics replace arrays wholesale, which is what makes `[]`
 * a clear rather than a no-op. Verified against the loyalty-object reference on
 * 2026-10-26: `merchantLocations` is a plain array field of the object resource.
 */

import type { GoogleWalletClient } from './google-client';
import type { LocationsSource } from './locations-source';
import type { MerchantLocation } from './object';
import type { WalletStore } from './store';

/**
 * How many passes one business-wide call patches.
 *
 * The caller pages with `after`. A cap exists because a venue change on a large
 * tenant is one request that would otherwise have no bound at all, and an
 * unbounded request is one that gets killed halfway with no record of where it
 * stopped.
 */
export const MAX_LOCATIONS_SYNC_PER_CALL = 200;

/** Patches in flight at once. Google's per-issuer limits are generous here. */
const PATCH_CONCURRENCY = 5;

/** The distance below which two coordinates are the same position. */
const POSITION_EPSILON = 1e-6;

export interface LocationsSyncDeps {
  store: WalletStore;
  client: GoogleWalletClient;
  /** The consent-filtered positions for a customer. */
  locations: LocationsSource;
}

export type CustomerLocationsOutcome =
  /** Google answered with the positions we sent. */
  | { kind: 'synced'; objectId: string; count: number }
  /** No tracking row, so there is no object to patch. Ordinary, not an error. */
  | { kind: 'no_pass' };

export interface BusinessLocationsFailure {
  customerId: string;
  reason: string;
}

export interface BusinessLocationsOutcome {
  synced: number;
  failed: number;
  /**
   * The cursor the next call should pass as `after`, or `null` when this page
   * was the last. A caller that ignores it leaves the remainder unsynchronised,
   * which is why it is part of the return value rather than a log line.
   */
  nextCursor: string | null;
  failures: BusinessLocationsFailure[];
}

/**
 * Google did not echo the positions the patch sent.
 *
 * Thrown, not returned: an object that accepted a patch and kept different
 * locations is a state this worker cannot reason about, and the same failure
 * mode `PassPatchNotAppliedError` exists for. The caller catches it per pass so
 * one bad object does not abandon the rest.
 */
export class LocationsPatchNotAppliedError extends Error {
  constructor(
    readonly objectId: string,
    readonly expected: number,
    readonly observed: number,
  ) {
    super(
      `Google Wallet object ${objectId} kept ${observed} merchant location(s) after a patch that ` +
        `sent ${expected}. The consent state and the pass now disagree.`,
    );
    this.name = 'LocationsPatchNotAppliedError';
  }
}

/**
 * Bring one customer's pass in step with their consent and the venue catalogue.
 *
 * Consent is read here, not by the caller: `merchantLocationsFor` is the gate,
 * and a caller that had already checked it would be a second definition of the
 * same rule.
 */
export async function syncCustomerLocations(
  deps: LocationsSyncDeps,
  input: { tenantId: string; customerId: string },
): Promise<CustomerLocationsOutcome> {
  const pass = await deps.store.findPass(input.customerId, input.tenantId);
  if (pass === null) {
    return { kind: 'no_pass' };
  }

  const positions = await deps.locations.merchantLocationsFor(input.customerId, input.tenantId);
  await applyLocations(deps, pass.objectId, positions);

  return { kind: 'synced', objectId: pass.objectId, count: positions.length };
}

/**
 * One page of the business's consenting pass holders, patched.
 *
 * Individual failures are collected rather than thrown: a pass Google answers
 * with a 403 is one customer the operator has to hear about, not a reason to
 * leave every other pass carrying a venue that closed.
 */
export async function syncBusinessLocations(
  deps: LocationsSyncDeps,
  input: { tenantId: string; after?: string | null; limit?: number },
): Promise<BusinessLocationsOutcome> {
  const limit = input.limit ?? MAX_LOCATIONS_SYNC_PER_CALL;

  // One extra row is the whole "is there another page" test. `limit + 1` is
  // bounded by the store (500), so a caller cannot ask for an unbounded read by
  // passing a huge number.
  const rows = await deps.store.listConsentingPasses({
    tenantId: input.tenantId,
    after: input.after ?? null,
    limit: limit + 1,
  });

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last !== undefined ? last.customerId : null;

  const outcome: BusinessLocationsOutcome = {
    synced: 0,
    failed: 0,
    nextCursor,
    failures: [],
  };

  for (let start = 0; start < page.length; start += PATCH_CONCURRENCY) {
    const batch = page.slice(start, start + PATCH_CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async (row) => {
        const positions = await deps.locations.merchantLocationsFor(row.customerId, input.tenantId);
        await applyLocations(deps, row.objectId, positions);
      }),
    );

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        outcome.synced += 1;
        return;
      }

      const row = batch[index];
      outcome.failed += 1;
      outcome.failures.push({
        customerId: row?.customerId ?? 'unknown',
        reason: describe(result.reason),
      });
    });
  }

  return outcome;
}

async function applyLocations(
  deps: LocationsSyncDeps,
  objectId: string,
  positions: MerchantLocation[],
): Promise<void> {
  const patched = await deps.client.patchObject(objectId, { merchantLocations: positions });

  // Post-condition, not optimism. The same rule `reconcilePass` applies to the
  // balance: Google echoes the stored resource, so a mismatch here means the
  // patch did not mean what this code thinks it means, and it is recorded as the
  // defect it is rather than as a successful sync.
  const applied = patched.merchantLocations ?? [];
  if (!samePositions(applied, positions)) {
    throw new LocationsPatchNotAppliedError(objectId, positions.length, applied.length);
  }
}

/**
 * Are these the same positions, in the same order?
 *
 * A tolerance rather than equality because the coordinates make a round trip
 * through JSON as floating point numbers. An exact comparison would turn a
 * representation difference into a failed withdrawal.
 */
function samePositions(left: readonly MerchantLocation[], right: readonly MerchantLocation[]): boolean {
  if (left.length !== right.length) return false;

  return left.every((point, index) => {
    const other = right[index];
    if (other === undefined) return false;
    return (
      Math.abs(point.latitude - other.latitude) <= POSITION_EPSILON &&
      Math.abs(point.longitude - other.longitude) <= POSITION_EPSILON
    );
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
