/**
 * Card-token rotation — the revocation path for the scannable credential
 * (docs/21 §2.5 and §3.3).
 *
 * ## Order: database first, then Google
 *
 * The new version, its hash and the audit row are written in one tenant
 * transaction before Google is asked anything. From that moment the old token
 * no longer resolves at the counter, which is the point of revoking it. Only
 * then is the barcode of an existing Google object patched and confirmed. A
 * patch that fails leaves the database rotated and answers `PASS_UPDATE_FAILED`:
 * the old card is already dead, and a retry is another audited rotation.
 *
 * ## What a rotation never touches
 *
 * `customers.global_id`, the Google `object_id`, the balance, the tier, the
 * ledger, the member code and the pass tracking row. The patch carries the
 * barcode and nothing else, so it carries no array and needs no
 * `replaceArrays`.
 */

import { confirmObjectBindings, describeBindingDefects, isUnconfirmed } from './bindings';
import type { ExpectedObjectBindings } from './bindings';
import { deriveCardToken, hashCardToken } from './card-token';
import { GoogleWalletApiError, GoogleWalletAuthError } from './google-client';
import type { GoogleWalletClient } from './google-client';
import { passObjectInserted } from './issuance';
import type { WalletCustomerRow, WalletStore } from './store';

export interface RotateCardTokenInput {
  /** The business the customer belongs to. The only tenant this call may touch. */
  tenantId: string;
  /** `customers.id`. */
  customerId: string;
  /** The operator who asked for the rotation, recorded in the audit row. */
  actorUserId: string;
  /** Why, recorded in the audit row. Validated by the caller. */
  reason: string;
}

export type RotateCardTokenResult =
  | { ok: true; version: number; pass: 'updated' | 'none' }
  | { ok: false; code: 'CUSTOMER_NOT_FOUND' | 'PASS_UPDATE_FAILED'; message: string };

export interface RotateCardTokenDeps {
  store: WalletStore;
  client: GoogleWalletClient;
  /** `CARD_TOKEN_SECRET`. */
  cardTokenSecret: string;
}

/**
 * How many times a compare-and-set that lost to a concurrent rotation is
 * retried from the freshly read version. Two operators pressing the button at
 * once is the only way to lose, so a handful is plenty.
 */
const MAX_ROTATION_ATTEMPTS = 3;

const CUSTOMER_NOT_FOUND_MESSAGE = 'No such customer in this business.';

export async function rotateCustomerCardToken(
  deps: RotateCardTokenDeps,
  input: RotateCardTokenInput,
): Promise<RotateCardTokenResult> {
  const { store, client } = deps;
  const { tenantId, customerId } = input;

  let customer: WalletCustomerRow | null = await store.findCustomerById(customerId, tenantId);
  let rotated: { version: number; token: string } | null = null;

  for (let attempt = 0; attempt < MAX_ROTATION_ATTEMPTS && rotated === null; attempt += 1) {
    if (customer === null) {
      return { ok: false, code: 'CUSTOMER_NOT_FOUND', message: CUSTOMER_NOT_FOUND_MESSAGE };
    }

    const expectedVersion = customer.cardTokenVersion ?? null;
    const newVersion = (expectedVersion ?? 0) + 1;
    // Derived before the write, so an empty secret refuses with nothing written.
    const token = await deriveCardToken({
      secret: deps.cardTokenSecret,
      tenantId,
      customerGlobalId: customer.globalId,
      version: newVersion,
    });

    const applied = await store.rotateCardToken({
      customerId,
      tenantId,
      expectedVersion,
      newVersion,
      newHash: await hashCardToken(token),
      actorUserId: input.actorUserId,
      reason: input.reason,
    });

    if (applied) {
      rotated = { version: newVersion, token };
    } else {
      customer = await store.findCustomerById(customerId, tenantId);
    }
  }

  if (customer === null) {
    return { ok: false, code: 'CUSTOMER_NOT_FOUND', message: CUSTOMER_NOT_FOUND_MESSAGE };
  }
  if (rotated === null) {
    throw new Error(
      `Card token rotation for customer ${customerId} in tenant ${tenantId} lost to concurrent ` +
        `rotations ${MAX_ROTATION_ATTEMPTS} times; nothing was written by this call.`,
    );
  }

  const { version, token } = rotated;

  // No Google object, nothing to rewrite: the next save link is built from the
  // new version. `not_saved` is Google having answered that it holds no object,
  // so a patch there could only 404.
  const pass = await store.findPass(customerId, tenantId);
  if (pass === null || pass.tenantId !== tenantId || !passObjectInserted(pass.state) || pass.state === 'not_saved') {
    console.log(
      `[wallet] Rotated the card token of customer ${customerId} in tenant ${tenantId} to ` +
        `version ${version}; no Google object to update.`,
    );
    return { ok: true, version, pass: 'none' };
  }

  const failed = (detail: string): RotateCardTokenResult => {
    console.error(
      `[wallet] Rotated the card token of customer ${customerId} in tenant ${tenantId} to ` +
        `version ${version}, but the pass barcode was not confirmed: ${detail}`,
    );
    return {
      ok: false,
      code: 'PASS_UPDATE_FAILED',
      message:
        `The card token moved to version ${version} and the previous one no longer resolves, but ` +
        `Google did not confirm the new barcode on the pass: ${detail}. Rotating again issues a ` +
        'new token and retries the update.',
    };
  };

  const program = await store.findProgram(tenantId);
  if (program === null) {
    return failed('the business has no Google class row to confirm the pass against');
  }

  // What the object must carry afterwards, from our own records: the recorded
  // id (never re-derived, so `object_id` cannot move), the class, the stored
  // member code and the new barcode.
  const expected: ExpectedObjectBindings = {
    id: pass.objectId,
    classId: program.classId,
    accountId: customer.memberCode ?? '',
    barcode: { type: 'QR_CODE', value: token },
  };

  let patched: unknown;
  try {
    patched = await client.patchObject(pass.objectId, { barcode: expected.barcode });
  } catch (err: unknown) {
    return failed(describePatchError(err));
  }

  const confirmed = await confirmObjectBindings(expected, patched, {
    getObject: (objectId) => client.getObject(objectId),
  });
  if (isUnconfirmed(confirmed)) {
    return failed(
      `${describeBindingDefects(confirmed.defects)}${confirmed.readFailed ? ' (the confirming read failed)' : ''}`,
    );
  }

  console.log(
    `[wallet] Rotated the card token of customer ${customerId} in tenant ${tenantId} to ` +
      `version ${version} and confirmed the new barcode at Google.`,
  );
  return { ok: true, version, pass: 'updated' };
}

/**
 * A patch failure, by status only. Google's own message can quote the object
 * id, which embeds `global_id`, so it is not repeated.
 */
function describePatchError(err: unknown): string {
  if (err instanceof GoogleWalletApiError) return `the update request failed (HTTP ${err.status})`;
  if (err instanceof GoogleWalletAuthError) return 'the Google Wallet credentials were refused';
  return 'the update request failed for a reason this worker does not classify';
}
