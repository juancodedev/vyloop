/**
 * Pass issuance (T9's API, not T9's button).
 *
 * Everything that decides *whether* a customer can obtain a pass, and *what* is
 * in it, lives here as plain functions over a `WalletStore`. The Hono layer in
 * `routes.ts` does nothing but translate HTTP into these calls and back, so
 * the rules can be broken one at a time in a test.
 *
 * ## The three rules this file exists to enforce
 *
 * 1. **The tenant comes from the token.** No function here accepts a tenant id
 *    from a request body, a query string or a path parameter. The caller
 *    passes what the gateway authenticated, and every read and write is
 *    narrowed to it.
 * 2. **A member code exists before a pass is built.** Not "usually", not "on
 *    the happy path" — the object builder is never reached with a null or
 *    malformed `accountId`, because the code is claimed and then **read back**
 *    before it is used.
 * 3. **The balance is read, never computed.** `latestBalance` is the ledger.
 *    Nothing in this file sums, adjusts, rounds or clamps a balance.
 */

import { classIdFor, objectIdFor } from './ids';
import { createSaveToWalletUrl } from './jwt';
import { findAvailableMemberCode, isValidMemberCode } from './member-code';
import { buildLoyaltyObject } from './object';
import type { LoyaltyObject } from './object';
import type { WalletProgramRow, WalletStore } from './store';

// ---------------------------------------------------------------------------
// Class readiness — the answer to the design question
// ---------------------------------------------------------------------------

/**
 * Why a tenant's Google class is or is not usable.
 *
 * `available` is the only success. The three failures are kept distinct
 * because they name different prerequisites and different people who have to
 * resolve them: a merchant (no class row at all), Google's review team (the
 * class exists but is not approved yet), and whoever operates the database (the
 * stored class id does not match the one the derivation rules produce). A
 * single opaque "wallet unavailable" would send all three to the same person
 * and fix none of them.
 */
export type ClassReadiness =
  | { ok: true; issuerId: string; classId: string }
  | { ok: false; reason: WalletUnavailableReason; message: string };

/** Stable, specific codes. A client branches on these, never on the prose. */
export const WALLET_CLASS_NOT_PROVISIONED = 'WALLET_CLASS_NOT_PROVISIONED';
export const WALLET_CLASS_NOT_APPROVED = 'WALLET_CLASS_NOT_APPROVED';
export const WALLET_CLASS_ID_MISMATCH = 'WALLET_CLASS_ID_MISMATCH';

export type WalletUnavailableReason =
  | 'available'
  | 'class_not_provisioned'
  | 'class_not_approved'
  | 'class_id_mismatch';

const REASON_CODES: Record<Exclude<WalletUnavailableReason, 'available'>, string> = {
  class_not_provisioned: WALLET_CLASS_NOT_PROVISIONED,
  class_not_approved: WALLET_CLASS_NOT_APPROVED,
  class_id_mismatch: WALLET_CLASS_ID_MISMATCH,
};

/** Map a reason to the stable code the HTTP layer puts in `error.code`. */
export function reasonCodeFor(reason: WalletUnavailableReason): string {
  return reason === 'available' ? 'OK' : REASON_CODES[reason];
}

/**
 * Decide whether this tenant's class can back a customer pass.
 *
 * ## Why the class is never created here
 *
 * The tempting implementation is: no row? Insert the class and carry on. It is
 * forbidden by the feature document, and the reason is technical rather than
 * stylistic. `reviewStatus` is a **per-class** field, an object requires its
 * class to already exist *and* be approved, and review state cannot return to
 * `DRAFT` once it has left. So a class created from the request path would:
 *
 * - start a human review when a random customer taps a button, which is
 *   precisely the delay the customer is watching;
 * - not help this request at all, because a `DRAFT` class still cannot create
 *   an object — the request would fail either way, only later and with a
 *   worse error;
 * - leave the tenant waiting on Google for something the merchant could have
 *   started during onboarding, which is the mitigation the document adopts.
 *
 * Creating at onboarding is what makes the review overlap merchant setup. This
 * function therefore only ever *reads* the row, and an absent row is an honest
 * answer naming the prerequisite, not a cue to go and do the merchant's setup
 * work in a request handler.
 *
 * ## The order the checks run in
 *
 * Not-approved is checked before id-mismatch on purpose. If both are wrong, the
 * actionable prerequisite is the review, not the id, and reporting the id would
 * send an operator to fix a string while the class is still unusable for the
 * reason Google has not finished looking at it.
 *
 * ## Failing closed
 *
 * `reviewStatus` is a `text` column with no `check` constraint, so it is
 * compared for **exact equality with `approved`**. A status this code has never
 * heard of — a value added by a future migration, a typo, a row written by hand
 * — is therefore treated as blocking. The alternative, an allow-list of
 * unusable states, silently starts issuing passes against a state nobody
 * reasoned about.
 */
export function classReadinessFor(
  program: WalletProgramRow | null,
  tenantId: string,
): ClassReadiness {
  if (program === null) {
    return {
      ok: false,
      reason: 'class_not_provisioned',
      message:
        'This business has no Google Wallet pass class yet. One class per business is created ' +
        'during business onboarding and reviewed by Google; a pass cannot exist until that ' +
        'review completes. Ask your business to finish setting it up.',
    };
  }

  if (program.reviewStatus !== 'approved') {
    return {
      ok: false,
      reason: 'class_not_approved',
      message:
        `The Google Wallet pass class for this business is in state "${program.reviewStatus}", ` +
        'and Google only allows passes against an approved class. The review is done by Google ' +
        'and cannot be skipped; your pass will be available as soon as it is approved.',
    };
  }

  // The class id is a pure function of the issuer id and the tenant id, so a
  // stored value that disagrees is a data defect rather than a config choice.
  //
  // Note the derivation uses the **requested** `tenantId`, not
  // `program.tenantId`. The store already filters by tenant, so a row for
  // another tenant should be unreachable — and if one ever is, deriving from
  // the requested tenant is what makes it a mismatch instead of a pass built
  // against somebody else's class. Tenant isolation enforced in two independent
  // places, one of which is a test rather than a filter.
  const expected = classIdFor(program.issuerId, tenantId);
  if (program.classId !== expected) {
    return {
      ok: false,
      reason: 'class_id_mismatch',
      message:
        'The stored Google Wallet pass class id does not match the id derived from the business ' +
        'and issuer ids. A pass built against it would be rejected by Google. This is an ' +
        'operational data error, not something the customer can resolve.',
    };
  }

  return { ok: true, issuerId: program.issuerId, classId: expected };
}

// ---------------------------------------------------------------------------
// Member code
// ---------------------------------------------------------------------------

/** Thrown when a code could not be claimed and the stored one is still unusable. */
export class MemberCodeUnavailableError extends Error {
  readonly customerId: string;
  readonly tenantId: string;

  constructor(customerId: string, tenantId: string) {
    super(
      `Could not obtain a usable member code for customer ${customerId} in tenant ${tenantId}. ` +
        'The pass was not built: an unusable accountId would render a pass that looks valid in ' +
        'the wallet and is dead at the counter.',
    );
    this.name = 'MemberCodeUnavailableError';
    this.customerId = customerId;
    this.tenantId = tenantId;
  }
}

export interface EnsureMemberCodeDeps {
  store: WalletStore;
  /** `MEMBER_CODE_PEPPER`. */
  pepper: string;
}

/**
 * Return a member code that is **stored**, deriving and persisting one only if
 * the customer has none.
 *
 * The load-bearing property is the return value: it is the value read back out
 * of `claimMemberCode`, which is the post-condition of a compare-and-set. A
 * request that loses a race returns the winner's code, and the pass is built
 * from that. Returning the locally derived candidate instead would let two
 * concurrent first-time issuances produce two different `accountId`s for one
 * customer, and only one of them would ever reach Google.
 *
 * ## When a code is created
 *
 * Lazily, on the request that first needs one — not at customer creation.
 * Minting at creation would spread a wallet secret into `workers/customer`,
 * which has no other reason to hold `MEMBER_CODE_PEPPER`, and would fill the
 * partial unique index with rows for customers who never open a pass. Laziness
 * is only safe because the issuance path has no branch that skips this function,
 * which is what makes "a pass is never built with a null `accountId`" a
 * structural property rather than a hope. A one-time backfill is supplied in
 * `sql/member-code-backfill.sql` for the rows that predate the column.
 *
 * ## A malformed stored code is repaired, not obeyed
 *
 * `isValidMemberCode` is false for a null code and equally for a code of the
 * wrong length or alphabet. Both are treated the same way: derive a fresh one.
 * The code is six display characters derived deterministically from ids the
 * customer cannot change, it is never machine-read by the POS, and refusing to
 * issue a pass over a bad display string would be a support incident for
 * something with a deterministic fix. The repair is logged rather than silent.
 */
export async function ensureMemberCode(
  deps: EnsureMemberCodeDeps,
  customerId: string,
  tenantId: string,
  customerGlobalId: string,
  storedCode: string | null,
): Promise<string> {
  if (isValidMemberCode(storedCode)) {
    // Returned from storage, never re-derived: a code a customer has already
    // memorised at a counter must not change because the algorithm was
    // refactored.
    //
    // Narrowed by hand rather than by a type predicate on
    // `isValidMemberCode`, which returns a plain boolean. That keeps the merged
    // pass model's public signature untouched by this change.
    if (storedCode === null || storedCode === undefined) {
      throw new MemberCodeUnavailableError(customerId, tenantId);
    }
    return storedCode;
  }

  if (storedCode !== null && storedCode !== '') {
    console.warn(
      `[wallet] customers.member_code for ${customerId} is ${JSON.stringify(storedCode)}, which is ` +
        'not a valid member code. Deriving a replacement; a pass must not carry a malformed ' +
        'accountId.',
    );
  }

  const candidate = await findAvailableMemberCode({
    tenantId,
    customerGlobalId,
    pepper: deps.pepper,
    isTaken: (code) => deps.store.isMemberCodeTaken(tenantId, code),
  });

  // The post-condition, not the input. Null means another request won the
  // compare-and-set first.
  const claimed = await deps.store.claimMemberCode(customerId, tenantId, candidate);
  if (claimed !== null && claimed !== undefined && isValidMemberCode(claimed)) {
    return claimed;
  }

  // Lost the race, or the row moved under us. Re-read once and use whatever is
  // genuinely stored. Nothing is re-derived here: a second derivation would
  // mint a different code and the whole point of the compare-and-set was to
  // converge on one.
  const reread = await deps.store.findCustomerById(customerId, tenantId);
  const rereadCode = reread?.memberCode;
  if (rereadCode !== null && rereadCode !== undefined && isValidMemberCode(rereadCode)) {
    return rereadCode;
  }

  throw new MemberCodeUnavailableError(customerId, tenantId);
}

// ---------------------------------------------------------------------------
// Pass issuance
// ---------------------------------------------------------------------------

export interface IssuePassDeps extends EnsureMemberCodeDeps {
  /** `GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL`. */
  serviceAccountEmail: string;
  /** `GOOGLE_WALLET_PRIVATE_KEY`, PEM-encoded. */
  privateKeyPem: string;
  /** `WALLET_ALLOWED_ORIGINS`, already parsed. Must not be empty. */
  origins: readonly string[];
  /**
   * Clock injection, so `iat` is assertable. Defaults to the system clock.
   *
   * Typed `Date | undefined` rather than plain `Date` because
   * `exactOptionalPropertyTypes` is on in this repository, and the value is
   * forwarded straight to `createSaveToWalletUrl`, whose `now?` has the same
   * constraint. `jwt.ts` already accepts `null | undefined` for this reason.
   */
  now?: Date | undefined;
}

export interface IssuePassInput {
  /** `X-Business-Id`. The only tenant this call may touch. */
  tenantId: string;
  /** `X-User-Id`, resolved to a customer row within `tenantId`. */
  customerId: string;
  customerGlobalId: string;
  customerFullName: string | null;
  storedMemberCode: string | null;
  /**
   * The `issuerId` from a successful `classReadinessFor`.
   *
   * Threaded in from the caller's readiness check rather than re-derived here,
   * so the pass is built against exactly the class that was validated. A second
   * derivation inside this function would be a second place to get the class id
   * wrong, and the two could disagree.
   */
  issuerId: string;
  /** The `classId` from the same successful readiness check. */
  classId: string;
}

export interface IssuedPass {
  /** The Add to Wallet link, ready for the customer to follow. */
  saveUrl: string;
  /** `<issuerId>.member-<globalId>`. */
  objectId: string;
  /** The tenant's class id. */
  classId: string;
  /** The stored member code, as it now reads in the database. */
  memberCode: string;
  /** The balance, copied from the ledger. */
  balancePoints: number;
  /** `loyalty_programs.points_currency`. */
  pointsCurrency: string;
  /** The signed object, exposed so a sync path can patch the same payload. */
  loyaltyObject: LoyaltyObject;
}

/**
 * The header above `LoyaltyObject`'s tier row.
 *
 * ## This is a documented gap, not an oversight
 *
 * `object.ts` requires a `tierHeader` whenever a `tierName` is supplied, and
 * says the value "normally comes from the tenant's configured
 * `rewardsTierLabel` on the class". But the class lives in Google's database,
 * not ours: `tenant_wallet_programs` has no label column, and the customer
 * request path deliberately does not read the class from Google. So on this
 * path there is no honest source for the header.
 *
 * The two available workarounds are both wrong. Inventing a string puts
 * hardcoded English chrome on a Spanish-language pass, which is the exact thing
 * `object.ts` refuses to do. Reading the class from Google on every pass request
 * makes a customer tapping a button depend on Google's API being up, so a bad
 * minute at Google becomes a broken button.
 *
 * So the pass currently carries no tier row: real data is omitted rather than
 * fabricated, and the omission is asserted by a test and reported by
 * `GET /v1/wallet/status` so whoever builds T9 can see it. The real fix is a
 * `rewards_tier_label` column on `tenant_wallet_programs`, which is a schema
 * change and therefore deliberately not made here.
 */
export const TIER_HEADER_UNAVAILABLE = null;

/**
 * Build a customer's save-to-wallet link.
 *
 * ## Why this makes no Google API call
 *
 * The JWT carries the object and Google creates it when the customer follows
 * the link, so the happy path needs no round trip. A customer tapping a button
 * must not fail because Google's API is having a bad minute, and a 200 with a
 * link is a contract that holds. Google's `jwt.insert` resolution remains on the
 * client interface for the paths that genuinely need Google's answer — the
 * program-status sync, and later a balance projection onto an already-saved
 * pass.
 *
 * ## Why the tracking row stays `not_issued`
 *
 * `customer_wallet_passes.state` means "a Google object exists". Handing out a
 * link does not create one; the object comes into being when the customer saves
 * it, and this system has no webhook or sync that would learn about that yet.
 * Writing `issued` here would assert a pass the customer does not have, which
 * is exactly the over-claiming `object.ts` guards against.
 *
 * @throws {MemberCodeUnavailableError} when no usable code could be obtained.
 *   Never a pass with a blank `accountId`.
 */
export async function issuePass(deps: IssuePassDeps, input: IssuePassInput): Promise<IssuedPass> {
  const memberCode = await ensureMemberCode(
    deps,
    input.customerId,
    input.tenantId,
    input.customerGlobalId,
    input.storedMemberCode,
  );

  // Read, never computed. This is the ledger's `balance_after`.
  const balancePoints = await deps.store.latestBalance(input.customerId, input.tenantId);

  // A business with no loyalty program has no currency to label a balance
  // with. Not defaulted: the pass is not built, because `loyaltyPoints.label` is
  // a required Google field and a made-up currency on a real pass is a lie the
  // member reads at the till.
  const pointsCurrency = await deps.store.findPointsCurrency(input.tenantId);
  if (pointsCurrency === null) {
    throw new LoyaltyProgramNotConfiguredError(input.tenantId);
  }

  const objectId = objectIdFor(input.issuerId, input.customerGlobalId);

  // `passState: 'issued'` is deliberate and is **not** the tracking state. The
  // object inside the save token is the object as it will be once Google
  // creates it, and Google creates it ACTIVE. The tracking row is not advanced
  // — see the module comment.
  const loyaltyObject = buildLoyaltyObject({
    issuerId: input.issuerId,
    classId: input.classId,
    customerId: input.customerId,
    customerGlobalId: input.customerGlobalId,
    customerFullName: input.customerFullName,
    memberCode,
    balancePoints,
    pointsCurrency,
    // Intentionally omitted: see TIER_HEADER_UNAVAILABLE.
    tierName: null,
    tierHeader: TIER_HEADER_UNAVAILABLE ?? undefined,
    passState: 'issued',
  });

  if (loyaltyObject.id !== objectId) {
    // Unreachable while the two derivations agree, which `ids.ts` guarantees
    // for the same inputs. Asserted anyway: this is the one place the recorded
    // `object_id` and the signed object could diverge, and a divergence would
    // mean the tracking row points at a pass Google never receives.
    throw new Error(
      `Derived pass id ${objectId} does not match the object that was built ` +
        `(${loyaltyObject.id}). Refusing to record a pass row for a different object.`,
    );
  }

  const saveUrl = await createSaveToWalletUrl({
    serviceAccountEmail: deps.serviceAccountEmail,
    privateKeyPem: deps.privateKeyPem,
    origins: deps.origins,
    loyaltyObjects: [loyaltyObject],
    // Conditional rather than `now: deps.now`, because this repository has
    // `exactOptionalPropertyTypes` on and `SignSaveToWalletJwtInput.now` is a
    // plain optional `Date`, which does not accept an explicit `undefined`.
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  await deps.store.recordPass({
    customerId: input.customerId,
    tenantId: input.tenantId,
    objectId: loyaltyObject.id,
    lastSyncedAt: null,
  });

  return {
    saveUrl,
    objectId: loyaltyObject.id,
    classId: loyaltyObject.classId,
    memberCode,
    balancePoints,
    pointsCurrency,
    loyaltyObject,
  };
}

/** Thrown when the tenant has a Google class but no loyalty program row. */
export class LoyaltyProgramNotConfiguredError extends Error {
  readonly tenantId: string;

  constructor(tenantId: string) {
    super(
      `Tenant ${tenantId} has a Google Wallet pass class but no loyalty program row, so there ` +
        'is no points currency to label the balance with. The pass was not built rather than ' +
        'built with an invented currency label.',
    );
    this.name = 'LoyaltyProgramNotConfiguredError';
    this.tenantId = tenantId;
  }
}
