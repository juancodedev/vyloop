/**
 * `LoyaltyClass` construction (T3).
 *
 * One class per tenant. The class is the merchant's program branding — logo,
 * program name, colours, row labels — so a rebrand is a single class patch that
 * propagates immediately to every object referencing it. That is the main
 * operational payoff of the one-class-per-tenant model, and the reason the
 * class must be created during tenant onboarding rather than lazily on a first
 * redemption.
 *
 * The class is also the unit of Google's review: `reviewStatus` is per class and
 * an object cannot be created against a class that is not `APPROVED`, and
 * review state cannot go back to `DRAFT` once it has left. So a draft or
 * under-review class must produce an honest, non-broken customer state — never
 * a "Add to Google Wallet" button that fails.
 *
 * Nothing here is invented. Every string comes from a real row or is an
 * explicitly optional parameter the caller chose to supply.
 */

import { classIdFor } from './ids';

/**
 * Google's `ReviewStatus` enum. The camelCase spellings (`draft`,
 * `underReview`, `approved`, `rejected`) are documented legacy aliases and are
 * deprecated; the SCREAMING_SNAKE forms are the current values.
 *
 * `REVIEW_STATUS_UNSPECIFIED` is deliberately not modelled: sending it would
 * leave the class in a state where the platform has no opinion, which is never
 * what this system means.
 *
 * @see https://developers.google.com/wallet/reference/rest/v1/ReviewStatus
 */
export type GoogleReviewStatus = 'DRAFT' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED';

/** A class state from which Google will accept an object insert. */
export type ReviewBlockingStatus = Extract<GoogleReviewStatus, 'DRAFT' | 'UNDER_REVIEW' | 'REJECTED'>;

/** An image reference as Google models it, without a localised description. */
export interface GoogleImage {
  sourceUri: { uri: string };
}

export interface LoyaltyClass {
  /** `<issuerId>.tenant-<tenantId>`. */
  id: string;
  /** `tenants.name`. Google's display may ellipsise after 20 characters. */
  issuerName: string;
  /** `loyalty_programs.name`. Google's display may ellipsise after 20 characters. */
  programName: string;
  reviewStatus: GoogleReviewStatus;
  /** ISO 3166-1 alpha-2, from `tenants.country`. */
  countryCode: string;
  programLogo?: GoogleImage;
  issuerLogo?: GoogleImage;
  hexBackgroundColor?: string;
  /** Row label above `LoyaltyObject.accountName`. Recommended max 15. */
  accountNameLabel?: string;
  /** Row label above `LoyaltyObject.accountId`. Recommended max 15. */
  accountIdLabel?: string;
  /** Row label above the per-customer tier. Recommended max 9. */
  rewardsTierLabel?: string;
}

export interface BuildLoyaltyClassInput {
  issuerId: string;
  /** `tenants.id` — never `tenants.slug`. */
  tenantId: string;
  /** `tenants.name`. */
  issuerName: string;
  /** `loyalty_programs.name`. */
  programName: string;
  /** `tenants.country`, e.g. `CL`. */
  countryCode: string;
  reviewStatus: GoogleReviewStatus;
  programLogo?: GoogleImage;
  issuerLogo?: GoogleImage;
  hexBackgroundColor?: string;
  accountNameLabel?: string;
  accountIdLabel?: string;
  rewardsTierLabel?: string;
}

/**
 * True when the class state blocks object creation.
 *
 * Google documents that a `DRAFT` class "cannot be used to create any object",
 * and the spec requires objects to reference an approved class. `REJECTED` is
 * included because a rejected class is equally unusable and, unlike draft, is
 * terminal.
 */
export function reviewStatusBlocksObjects(status: GoogleReviewStatus): status is ReviewBlockingStatus {
  return status === 'DRAFT' || status === 'UNDER_REVIEW' || status === 'REJECTED';
}

/**
 * Build a `LoyaltyClass`.
 *
 * `issuerName` and `programName` are stored in full even though Google may
 * ellipsise them after 20 characters. Truncating here would corrupt the
 * merchant's real name in Google's database and could not be undone by a
 * subsequent patch that carried the full value, because a shortened string is
 * indistinguishable from a deliberate rename. The ellipsis is Google's display
 * decision; the stored value stays correct.
 *
 * `countryCode` is uppercased. That is a normalisation, not a truncation: ISO
 * 3166-1 alpha-2 is defined in uppercase and `tenants.country` is free text with
 * no format constraint, so `cl` and `CL` are the same country and must not
 * produce two classes.
 */
export function buildLoyaltyClass(input: BuildLoyaltyClassInput): LoyaltyClass {
  if (input.issuerName.trim().length === 0) {
    throw new Error('tenants.name is empty; a class cannot be built from a blank issuer name.');
  }
  if (input.programName.trim().length === 0) {
    throw new Error(
      'loyalty_programs.name is empty; a class cannot be built from a blank program name.',
    );
  }
  if (input.countryCode.trim().length === 0) {
    throw new Error('tenants.country is empty; countryCode is required by Google.');
  }

  const loyaltyClass: LoyaltyClass = {
    id: classIdFor(input.issuerId, input.tenantId),
    issuerName: input.issuerName,
    programName: input.programName,
    reviewStatus: input.reviewStatus,
    countryCode: input.countryCode.trim().toUpperCase(),
  };

  // Optional presentation fields are copied only when the caller supplied
  // them. Inventing a default logo URL or a background colour would put fake
  // merchant branding in front of a real customer.
  if (input.programLogo !== undefined) loyaltyClass.programLogo = input.programLogo;
  if (input.issuerLogo !== undefined) loyaltyClass.issuerLogo = input.issuerLogo;
  if (input.hexBackgroundColor !== undefined) {
    loyaltyClass.hexBackgroundColor = input.hexBackgroundColor;
  }
  if (input.accountNameLabel !== undefined) loyaltyClass.accountNameLabel = input.accountNameLabel;
  if (input.accountIdLabel !== undefined) loyaltyClass.accountIdLabel = input.accountIdLabel;
  if (input.rewardsTierLabel !== undefined) loyaltyClass.rewardsTierLabel = input.rewardsTierLabel;

  return loyaltyClass;
}
