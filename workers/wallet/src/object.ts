/**
 * `LoyaltyObject` construction (T4).
 *
 * One object per customer, referencing that customer's tenant class. The object
 * is a **projection** of the ledger, never a second ledger: the balance comes
 * from `points_transactions.balance_after` and is not computed here.
 *
 * Two facts about this payload are easy to get wrong and both are load-bearing:
 *
 * - `accountId` is the short member code, because Google's recommended maximum
 *   is 20 characters and `globalId` is 36. See `member-code.ts`.
 * - `barcode.value` is the **full** `globalId`, because the POS resolves
 *   customers only by `globalId` (`GET /v1/customers/n/:globalId`). Moving the
 *   short code into the barcode would have forced a change to the POS contract
 *   for no gain.
 */

import { formatBalance } from './balance';
import { objectIdFor } from './ids';
import { isValidMemberCode } from './member-code';

/**
 * Google's `State` enum. The camelCase spellings are deprecated legacy aliases,
 * as with `ReviewStatus`.
 *
 * `PENDING` is modelled but never produced by `objectStateFor`: it means the
 * platform holds an object the user has not activated, which is a different
 * claim from "vyloop has not issued this pass yet".
 *
 * @see https://developers.google.com/wallet/reference/rest/v1/State
 */
export type GoogleObjectState =
  | 'STATE_UNSPECIFIED'
  | 'PENDING'
  | 'ACTIVE'
  | 'INACTIVE'
  | 'EXPIRED'
  | 'COMPLETED';

/**
 * `customer_wallet_passes.state` — vyloop's own tracking state.
 *
 * `not_issued` is the important one: it means no Google object exists yet, so
 * the object builder must not be called at all.
 *
 * `not_saved` is the second one, and it exists because `not_issued` was carrying
 * two different claims. Before reconciliation, `not_issued` meant both "we have
 * never handed this customer a link" and "we handed them one and never found
 * out whether they took it". Collapsing those makes the row useless for support:
 * the first is a state the customer is in, the second is a gap in our
 * knowledge, and a merchant reading the second as the first is told a customer
 * has no pass when we simply never checked.
 *
 * `not_saved` is the honest form of the second: a save link was issued, Google
 * was asked, and Google has no object. `reconcile.ts` is the only writer.
 */
export type PassTrackingState =
  | 'not_issued'
  | 'not_saved'
  | 'issued'
  | 'inactive'
  | 'expired'
  | 'completed';

export interface LoyaltyPointsBalance {
  /** Rendered without thousands separators. See `balance.ts`. */
  string: string;
}

export interface LoyaltyPoints {
  /** The program's point currency, e.g. `puntos`. Recommended max 9. */
  label: string;
  balance: LoyaltyPointsBalance;
}

export interface Barcode {
  /**
   * `QR_CODE` is the only format that survives a 36-character payload on a
   * counter scanner. The narrow symbologies (`CODE_128`, `EAN_13`, …) cannot
   * hold a UUID at a scannable width.
   */
  type: 'QR_CODE';
  value: string;
}

export interface TextModuleData {
  header: string;
  body: string;
  id: string;
}

export interface LoyaltyObject {
  /** `<issuerId>.member-<customerGlobalId>`. */
  id: string;
  /** The tenant's class id. */
  classId: string;
  state: GoogleObjectState;
  /** `customers.full_name`. Omitted when the customer has no name on file. */
  accountName?: string;
  /** The stored 6-character member code. */
  accountId: string;
  loyaltyPoints: LoyaltyPoints;
  /** Carries the full `customers.global_id` for the POS. */
  barcode: Barcode;
  /** The customer's tier, from `membership_tiers.name`. */
  textModulesData?: TextModuleData[];
}

/** Stable id for the tier row, so a later patch replaces it rather than appends. */
export const REWARDS_TIER_MODULE_ID = 'REWARDS_TIER';

/** Thrown when a pass has no Google object, so none may be built. */
export class PassNotIssuedError extends Error {
  constructor(customerId: string, passState: 'not_issued' | 'not_saved' = 'not_issued') {
    super(
      `Pass for customer ${customerId} is in state "${passState}": no Google object exists ` +
        'for it yet. Build and insert the object first, then transition the pass to "issued". ' +
        'Mapping that state onto a Google state would assert a pass the customer does not have.',
    );
    this.name = 'PassNotIssuedError';
  }
}

/**
 * Map vyloop's tracking state onto Google's `State`.
 *
 * @throws {PassNotIssuedError} for `not_issued` and `not_saved`, which have no
 * Google counterpart by design. `not_saved` is grouped with `not_issued` rather
 * than mapped to `PENDING`: `PENDING` means *the platform holds an object the
 * user has not activated*, which is a positive claim about an existing object,
 * and neither state is a claim about an object at all.
 */
export function objectStateFor(
  passState: PassTrackingState,
  customerId: string,
): GoogleObjectState {
  switch (passState) {
    case 'issued':
      return 'ACTIVE';
    case 'inactive':
      return 'INACTIVE';
    case 'expired':
      return 'EXPIRED';
    case 'completed':
      return 'COMPLETED';
    case 'not_issued':
    case 'not_saved':
      throw new PassNotIssuedError(customerId, passState);
  }
}

export interface BuildLoyaltyObjectInput {
  issuerId: string;
  /** The tenant's full class id, `tenant_wallet_programs.class_id`. */
  classId: string;
  /** `customers.id`, used only for the error message. */
  customerId: string;
  /** `customers.global_id`. The pass id and the barcode both derive from this. */
  customerGlobalId: string;
  /**
   * `customers.full_name`. Optional: a customer may have no name on file.
   *
   * `undefined` is accepted alongside `null` because that is what a row read
   * through a projection that omits the column actually yields, and
   * `exactOptionalPropertyTypes` would otherwise make the caller cast.
   */
  customerFullName?: string | null | undefined;
  /** `customers.member_code`. Required: it is the whole point of `accountId`. */
  memberCode: string;
  /** The customer's current balance, read from the ledger by the caller. */
  balancePoints: number;
  /** `loyalty_programs.points_currency`, e.g. `puntos`. */
  pointsCurrency: string;
  /** `membership_tiers.name`. Optional: a customer may have no tier yet. */
  tierName?: string | null | undefined;
  /**
   * Row header for the tier, normally the tenant's configured
   * `rewardsTierLabel` on the class. Required whenever `tierName` is set: the
   * builder will not invent display text, because a hardcoded header would put
   * English chrome on a Spanish-language pass.
   */
  tierHeader?: string | undefined;
  passState: PassTrackingState;
}

/**
 * Build a `LoyaltyObject`.
 *
 * @throws {PassNotIssuedError} when the pass has no Google object yet.
 * @throws {Error} when `memberCode` is missing or malformed, or the balance
 * cannot be rendered. A pass built with a blank `accountId` would look
 * perfectly valid in the wallet and be useless at the counter, so this fails
 * rather than degrading.
 */
export function buildLoyaltyObject(input: BuildLoyaltyObjectInput): LoyaltyObject {
  if (!isValidMemberCode(input.memberCode)) {
    throw new Error(
      `customers.member_code for customer ${input.customerId} is ${JSON.stringify(input.memberCode)}, ` +
        'which is not a valid 6-character Crockford Base32 member code. Generate and store ' +
        'one before building the pass; a pass with a blank accountId is a dead end at the counter.',
    );
  }

  const loyaltyObject: LoyaltyObject = {
    id: objectIdFor(input.issuerId, input.customerGlobalId),
    classId: input.classId,
    state: objectStateFor(input.passState, input.customerId),
    accountId: input.memberCode,
    loyaltyPoints: {
      label: input.pointsCurrency,
      balance: { string: formatBalance(input.balancePoints) },
    },
    barcode: { type: 'QR_CODE', value: input.customerGlobalId },
  };

  // Omitted, never substituted. A customer with no name on file gets a pass
  // with no name row rather than one reading "Member" or an empty string.
  if (input.customerFullName !== null && input.customerFullName !== undefined) {
    loyaltyObject.accountName = input.customerFullName;
  }

  if (input.tierName !== null && input.tierName !== undefined && input.tierName !== '') {
    if (input.tierHeader === undefined || input.tierHeader.trim() === '') {
      throw new Error(
        `A tier name was supplied for customer ${input.customerId} without a tierHeader. ` +
          "Pass the tenant's configured rewardsTierLabel; the builder will not invent display text.",
      );
    }
    loyaltyObject.textModulesData = [
      { header: input.tierHeader, body: input.tierName, id: REWARDS_TIER_MODULE_ID },
    ];
  }

  return loyaltyObject;
}
