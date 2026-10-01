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

/**
 * A text row, as Google models it.
 *
 * Used here instead of `infoModuleData`, which Google's discovery document marks
 * **deprecated on both the class and the object**: *"Deprecated. Use
 * textModulesData instead."* It is also the field with the documented character
 * limits, which is what makes a limit checkable before the insert rather than
 * after it.
 *
 * `id` is stable per row so a later `patchClass` replaces that row rather than
 * appending a second copy of it. The same reason `REWARDS_TIER_MODULE_ID`
 * exists on the object side.
 *
 * @see https://developers.google.com/wallet/reference/rest/v1/TextModuleData
 */
export interface GoogleTextModuleData {
  /** Recommended maximum 35 characters. */
  header: string;
  /** Recommended maximum 500 characters. */
  body: string;
  /** Alphanumeric, `_` and `-` only. Google rejects dots. */
  id: string;
}

/**
 * Google's `LinksModuleData`. The field is called `linksModuleData`, not
 * `links`, and it exists on **both** the class and the object.
 *
 * @see https://developers.google.com/wallet/reference/rest/v1/LinksModuleData
 */
export interface GoogleLinksModuleData {
  uris: GoogleUri[];
}

/**
 * Google's documented recommended maxima, in characters.
 *
 * Every one of these is a *recommendation*, not a rejection: Google ellipsises
 * what does not fit rather than refusing the request. That is exactly why they
 * are enforced here. "Puntos disponibles" is 18 characters against a documented
 * 15 for `rewardsTierLabel`, and the pass would render "Puntos disponibl…" in
 * front of a customer with no error anywhere to explain it — a build-time
 * failure names the limit, a Google error at insert time names nothing about
 * which field was too long.
 *
 * Verified against the API discovery document, revision 20261001.
 */
export const GOOGLE_LABEL_MAX_LENGTHS = {
  accountNameLabel: 15,
  accountIdLabel: 15,
  rewardsTierLabel: 9,
  textModuleHeader: 35,
  textModuleBody: 500,
  uriDescription: 20,
} as const;

/**
 * A link the pass offers, as Google models it.
 *
 * `description` is not decoration: Google's review reads the label next to the
 * link, and a class whose homepage says nothing is one of the reasons a loyalty
 * class is rejected. See `docs/11-crear-tarjeta-lealtad.md`.
 */
export interface GoogleUri {
  uri: string;
  description?: string;
}

/**
 * The language tag a `localizedIssuerName` is written in.
 *
 * `es-CL` because that is the value Google's review accepted for the one class
 * this system has created by hand, and because `tenants.language` defaults to
 * it. A merchant outside Chile is the slice that would make this per-tenant:
 * reading that column is a change to the provisioning step, not to this
 * constant, and until it happens the tag names the language of the pass surface
 * we actually ship rather than inventing one per country.
 */
export const ISSUER_NAME_LANGUAGE = 'es-CL';

export interface LoyaltyClass {
  /** `<issuerId>.tenant-<tenantId>`. */
  id: string;
  /** `tenants.name`. Google's display may ellipsise after 20 characters. */
  issuerName: string;
  /**
   * The same name, localised. **This is the field Google's loyalty pass reads**
   * at the top of the card — the platform is the registered issuer, but the
   * card says which business it belongs to, and a class carrying only the flat
   * `issuerName` does not say it.
   *
   * Not optional: it is derived from `issuerName`, which is required, so there
   * is no input for a caller to get wrong or forget.
   */
  localizedIssuerName: { defaultValue: { language: string; value: string } };
  /** `loyalty_programs.name`. Google's display may ellipsise after 20 characters. */
  programName: string;
  reviewStatus: GoogleReviewStatus;
  /** ISO 3166-1 alpha-2, from `tenants.country`. */
  countryCode: string;
  programLogo?: GoogleImage;
  /**
   * Where the pass's programme lives.
   *
   * Optional here and required by Google's review, which is the awkward part: a
   * class built without it will be refused, and this builder has no way to know
   * whether the caller has a public URL to offer. Inventing one would put a link
   * that 404s in a real customer's hand, so the field is absent unless supplied.
   */
  homepageUri?: GoogleUri;
  hexBackgroundColor?: string;
  /** Row label above `LoyaltyObject.accountName`. Recommended max 15. */
  accountNameLabel?: string;
  /** Row label above `LoyaltyObject.accountId`. Recommended max 15. */
  accountIdLabel?: string;
  /** Row label above the per-customer tier. Recommended max 9. */
  rewardsTierLabel?: string;
  /**
   * The merchant's own sentence about the programme, as a text row.
   *
   * On the **class**, not the object, and that is the load-bearing part of the
   * decision. Google's discovery document says both sides are displayed when
   * both define it — *"If text module data is also defined on the class, both
   * will be displayed. The maximum number of these fields displayed is 10 from
   * the object and 10 from the class"* — so the two sides do not compete for the
   * same ten slots and the object's tier row survives.
   *
   * The reason it is still the right side: this text is the same for every
   * customer of a merchant. Changing a promotion is one class patch; on the
   * object it would be N patches, one per customer, and Google's patch semantics
   * replace an array wholesale — so a balance projection that rebuilt
   * `textModulesData` would silently drop the promotion. See `reconcile.ts`.
   */
  textModulesData?: GoogleTextModuleData[];
  /**
   * The pass's links, on the class for the same reason `textModulesData` is:
   * they are per-merchant, and a class patch propagates to every object.
   */
  linksModuleData?: GoogleLinksModuleData;
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
  /** Supplied, never derived: see `LoyaltyClass.homepageUri`. */
  homepageUri?: GoogleUri;
  hexBackgroundColor?: string;
  accountNameLabel?: string;
  accountIdLabel?: string;
  rewardsTierLabel?: string;
  /**
   * `loyalty_programs.promo_copy`: the merchant's own sentence about what the
   * programme is for.
   *
   * Omitted, never substituted. A business that has written no promotion gets a
   * pass with no promo row rather than one reading a generic sentence nobody
   * authored, and never an empty string, which Google renders as a header over
   * nothing.
   */
  promoCopy?: string;
  /**
   * The pass's links. Supplied by the caller because only it knows the customer
   * web's origin; see `LoyaltyClass.linksModuleData`.
   */
  links?: GoogleUri[];
}

/**
 * The row id of the merchant's promo copy.
 *
 * Stable, so a later `patchClass` replaces that row rather than appending a
 * second copy. Same reason `REWARDS_TIER_MODULE_ID` exists on the object side.
 */
export const PROMO_COPY_MODULE_ID = 'PROMO_COPY';

/**
 * The header above the merchant's promo copy.
 *
 * Pass-surface chrome in the pass-surface language, on the same footing as
 * `ISSUER_NAME_LANGUAGE`: it names what the row *is* ("this business's own
 * words"), not anything the merchant said. Making it per-merchant is a column
 * and a review question, not a constant to vary.
 *
 * Within Google's documented 35-character maximum for
 * `TextModuleData.header`, which the builder checks.
 */
export const PROMO_COPY_HEADER = 'Info';

/**
 * True when a class state blocks object creation.
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
 * Refuse a label Google would ellipsise, naming the limit in the message.
 *
 * ## Why this is not left to Google
 *
 * Every limit in `GOOGLE_LABEL_MAX_LENGTHS` is documented as a *recommendation*.
 * Nothing is rejected. Google renders `Puntos disponibl…` and the insert returns
 * 200, so the defect surfaces in a customer's wallet and nowhere else — no log,
 * no error, no review finding. A build-time refusal moves the same fact to where
 * it can be acted on and says which field and which number.
 *
 * `undefined` is not a violation: these fields are optional and an absent label
 * is a legitimate merchant choice, distinct from a too-long one.
 */
function assertWithinLabelLimit(
  field: string,
  value: string | undefined,
  limitKey: keyof typeof GOOGLE_LABEL_MAX_LENGTHS = field as keyof typeof GOOGLE_LABEL_MAX_LENGTHS,
): void {
  if (value === undefined) return;
  const max = GOOGLE_LABEL_MAX_LENGTHS[limitKey];
  if (value.length > max) {
    throw new Error(
      `${field} is ${value.length} characters long and Google documents a maximum of ${max} for ` +
        'this field. It would be ellipsised on the pass with no error from Google, so the class is ' +
        'refused here instead. Shorten the value rather than raising the limit.',
    );
  }
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
 *
 * `localizedIssuerName` carries the merchant's name unchanged, in the language
 * of the pass surface. It is not a second name: it is the field Google reads,
 * and truncating or reformatting it while `issuerName` stayed whole would give a
 * class whose two names disagree.
 *
 * @throws {Error} for a blank required field, or for a label longer than the
 *   limit Google documents for it. See `assertWithinLabelLimit`.
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
    localizedIssuerName: {
      defaultValue: { language: ISSUER_NAME_LANGUAGE, value: input.issuerName },
    },
    programName: input.programName,
    reviewStatus: input.reviewStatus,
    countryCode: input.countryCode.trim().toUpperCase(),
  };

  // Optional presentation fields are copied only when the caller supplied
  // them. Inventing a default logo URL or a background colour would put fake
  // merchant branding in front of a real customer.
  if (input.programLogo !== undefined) loyaltyClass.programLogo = input.programLogo;
  if (input.homepageUri !== undefined) loyaltyClass.homepageUri = input.homepageUri;
  if (input.hexBackgroundColor !== undefined) {
    loyaltyClass.hexBackgroundColor = input.hexBackgroundColor;
  }
  if (input.accountNameLabel !== undefined) loyaltyClass.accountNameLabel = input.accountNameLabel;
  if (input.accountIdLabel !== undefined) loyaltyClass.accountIdLabel = input.accountIdLabel;
  if (input.rewardsTierLabel !== undefined) loyaltyClass.rewardsTierLabel = input.rewardsTierLabel;

  // Checked here rather than left to Google. Every one of these is a documented
  // *recommendation*, so exceeding it does not fail the insert — Google
  // ellipsises. That is precisely the failure worth catching early: a label
  // reading "Puntos disponibl…" in a customer's wallet with no error anywhere,
  // versus a build that refuses and names the limit.
  assertWithinLabelLimit('accountNameLabel', input.accountNameLabel);
  assertWithinLabelLimit('accountIdLabel', input.accountIdLabel);
  assertWithinLabelLimit('rewardsTierLabel', input.rewardsTierLabel);

  // Omitted, never substituted. Blank is absent: an empty `body` renders as a
  // promo row with a header and nothing under it, which is worse than no row.
  if (input.promoCopy !== undefined && input.promoCopy.trim() !== '') {
    assertWithinLabelLimit(
      `textModulesData[${PROMO_COPY_MODULE_ID}].header`,
      PROMO_COPY_HEADER,
      'textModuleHeader',
    );
    assertWithinLabelLimit(
      `textModulesData[${PROMO_COPY_MODULE_ID}].body`,
      input.promoCopy,
      'textModuleBody',
    );
    loyaltyClass.textModulesData = [
      { id: PROMO_COPY_MODULE_ID, header: PROMO_COPY_HEADER, body: input.promoCopy },
    ];
  }

  if (input.links !== undefined && input.links.length > 0) {
    for (const link of input.links) {
      assertWithinLabelLimit('linksModuleData.uris[].description', link.description, 'uriDescription');
    }
    loyaltyClass.linksModuleData = { uris: input.links };
  }

  return loyaltyClass;
}
