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

import { DEMO_MODE_NAME_PREFIX, classIdFor, objectIdFor } from './ids';
import { createSaveToWalletUrl } from './jwt';
import type { LocationsSource } from './locations-source';
import { findAvailableMemberCode, isValidMemberCode } from './member-code';
import { buildLoyaltyObject } from './object';
import type { LoyaltyObject } from './object';
import type { WalletPassRow, WalletProgramRow, WalletStore } from './store';

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
 * ## The question this answers, stated so it cannot drift
 *
 * **"Will Google accept an object for this class?"** Not "is this merchant in
 * demo mode".
 *
 * Those are two questions about two different objects, and conflating them is
 * the bug this function used to have. Google accepts an object against a class
 * that is `approved`, or against a class it has put in demo mode — which we
 * recognise by the marker on the stored id (`DEMO_MODE_NAME_PREFIX`, declared
 * once in `ids.ts`, and deliberately not spelled out in this file). Demo mode says *who
 * receives the pass*: Google's demo-mode issuer accounts only deliver to their
 * own Admin/Developer/test accounts. It says nothing about whether the object can
 * be created at all.
 *
 * The old rule was `reviewStatus !== 'approved' && !demoMode`, where `demoMode`
 * was `envDemoMode || program.demoMode !== false`. In production that let a
 * `draft` class through on the strength of a `demo_mode: true` row, and the pass
 * route then got:
 *
 * ```
 * 404: Wallet Object Class {...} not approved
 * ```
 *
 * from `insertObject`, which the route's catch turned into
 * `WALLET_PASS_NOT_CREATABLE` — a code whose customer-facing copy said *"podés
 * reintentar en un rato"*. That advice cannot work: the review is Google's and it
 * takes days. Two of the five production tenants were hitting it
 * (`cafe-prueba-0117`, `sonda-a2-1116`), and the three that worked were all
 * `approved` — the `demo_mode` column happened to correlate with the outcome and
 * so the rule looked correct.
 *
 * ## `envDemoMode` is deliberately not consulted here
 *
 * It stays on the signature because it is a real fact about the deployment and
 * because dropping it would make this diff about a signature rather than about
 * the rule. It is **not** part of the answer, and that is the point worth
 * recording.
 *
 * Two ways to keep it, both wrong:
 *
 * - **As an allowance** (what it was): `workers/wallet/wrangler.jsonc` ships
 *   `WALLET_DEMO_MODE: "true"`, so a global flag would put every `draft` tenant
 *   back through this gate and the 404 would return with them. One environment
 *   variable, two tenants, one support queue.
 * - **As a ceiling that refuses every mint**: production would stop issuing
 *   entirely, including for the three approved tenants that work today.
 *
 * So it answers a question this function does not ask. Delivery is decided
 * where delivery is known: `GET /v1/wallet/status` reports `demo_mode` and the
 * customer web's delivery guard refuses to offer the card, and `sweep.ts` refuses
 * to write at all in demo mode. The pass route deliberately does not refuse on
 * demo mode — the people who can test are the customers on Google's test-account
 * list, and they hold the `customer` role, so refusing them blocked everyone.
 *
 * ## `demo_mode` on the row is untouched, and that is its actual job
 *
 * It is still written, still read, still surfaced by the operator console
 * (`PUT /v1/wallet/program/demo-mode`) and still read by the inactivity sweep.
 * It answers *who receives this pass*. It no longer answers *whether this class
 * can back one*, which is what it was never able to answer.
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
 *
 * ## The marker is read, never re-spelled
 *
 * The marker is declared once, in `ids.ts`. It is read from there here, and a
 * contract test asserts this file holds no literal copy — because the way this
 * bug comes back is somebody typing the prefix a second time because they did not
 * know where it lived, after which the gate and the marker drift apart and only
 * one of them moves.
 *
 * The marker is a **name** marker: it is how *we* recognise a class Google put in
 * demo mode, not part of the resource identifier Google knows it by. So the
 * derivation check runs on the id **behind** the marker, and the returned
 * `classId` is the derived one — an object built against the marked string is a
 * 400 at the customer's tap. A marker is not a way to skip the derivation check
 * either: skipping it is exactly how a pass gets built against somebody else's
 * class, and there is a test for that.
 */
export function classReadinessFor(
  program: WalletProgramRow | null,
  tenantId: string,
  envDemoMode: boolean,
): ClassReadiness {
  // Read once so the "does this id carry the marker" question and the "strip it
  // before comparing" question cannot disagree. `void envDemoMode` is here so the
  // unused parameter is a decision the reader can see rather than an accident.
  void envDemoMode;

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

  // Google's own two shapes for a class it will accept an object against. The
  // prefix is read from `ids.ts` rather than spelled here: see the note above.
  const markedClassId = program.classId.startsWith(DEMO_MODE_NAME_PREFIX);
  const storedClassId = markedClassId
    ? program.classId.slice(DEMO_MODE_NAME_PREFIX.length)
    : program.classId;

  // `approved` is one of the two; the marker is the other. Nothing else, and in
  // particular not `demo_mode` — which is why `cafe-prueba-0117` and
  // `sonda-a2-1116` stop being waved through here.
  if (program.reviewStatus !== 'approved' && !markedClassId) {
    return {
      ok: false,
      reason: 'class_not_approved',
      message:
        `The Google Wallet pass class for this business is in state "${program.reviewStatus}", ` +
        'and Google does not create pass objects against a class it has not approved. The class ' +
        'has to be submitted by the business and approved by Google, which takes days; asking ' +
        'again does not change the answer, so this is not something a customer can resolve by ' +
        'retrying.',
    };
  }

  // The class id is a pure function of the issuer id and the tenant id, so a
  // stored value that disagrees is a data defect rather than a config choice.
  //
  // Compared against the id **behind the marker**, so the demo marker widens what
  // this gate accepts without ever widening what the derivation accepts.
  //
  // Note the derivation uses the **requested** `tenantId`, not
  // `program.tenantId`. The store already filters by tenant, so a row for
  // another tenant should be unreachable — and if one ever is, deriving from
  // the requested tenant is what makes it a mismatch instead of a pass built
  // against somebody else's class. Tenant isolation enforced in two independent
  // places, one of which is a test rather than a filter.
  const expected = classIdFor(program.issuerId, tenantId);
  if (storedClassId !== expected) {
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
   * The positions this customer's pass may carry, already consent-filtered.
   *
   * A port rather than a store method: the pass lifecycle and the venue catalog
   * are different reads, and the builder only needs the answer.
   */
  locations: LocationsSource;
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
 * Build the `LoyaltyObject` and sign the save link, and stop there.
 *
 * The shared half of both issuance paths. It reads the member code, the ledger
 * balance and the tenant's points currency, builds the object and signs a link
 * naming it — and it writes nothing and calls nothing. Both of the decisions the
 * two callers differ on live *around* it:
 *
 * - `issuePass` records the tracking row and lets the caller create the object at
 *   Google, because for a customer with no pass there is nothing to reuse.
 * - `linkForExistingPass` does neither, because there is a pass row already and
 *   it is the record of what Google holds.
 *
 * So the member code, the balance and the class are read the same way on both,
 * and a re-issued link can never carry a balance frozen at some earlier visit.
 *
 * @param existingObjectId the id a tracking row already recorded, when one
 *   exists. See `linkForExistingPass` for why the recorded id wins over the
 *   derived one.
 */
async function buildSignedPass(
  deps: IssuePassDeps,
  input: IssuePassInput,
  existingObjectId?: string | undefined,
): Promise<IssuedPass> {
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

  // `passState: 'issued'` is deliberate and is **not** the tracking state. The
  // object inside the save token is the object as it will be once Google has
  // applied it, and Google applies it ACTIVE. The tracking row is not advanced
  // — see the module comment.
  const merchantLocations = await deps.locations.merchantLocationsFor(
    input.customerId,
    input.tenantId,
  );

  let loyaltyObject = buildLoyaltyObject({
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
    merchantLocations,
  });

  if (existingObjectId === undefined) {
    const objectId = objectIdFor(input.issuerId, input.customerGlobalId);

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
  } else if (loyaltyObject.id !== existingObjectId) {
    // The recorded id wins, and the object is re-stamped with it rather than the
    // call being refused. `store.ts` states the rule this follows: the row is the
    // record of what was actually issued, and acting on a freshly derived id
    // would be acting on a pass this system never handed out. The derivations
    // agree today, so this branch is unreachable in production — and if they ever
    // diverge, the id Google actually holds is the recorded one.
    loyaltyObject = { ...loyaltyObject, id: existingObjectId };
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

/**
 * Build a customer's save-to-wallet link for a pass that does not exist yet.
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
  const issued = await buildSignedPass(deps, input);

  await deps.store.recordPass({
    customerId: input.customerId,
    tenantId: input.tenantId,
    objectId: issued.objectId,
    lastSyncedAt: null,
  });

  return issued;
}

// ---------------------------------------------------------------------------
// Idempotent issuance
//
// The problem this answers, stated as it actually happened: the pass route
// always minted. Every visit re-derived the object, re-inserted it at Google,
// took the 409 that produced, and patched — and a pass that could not be patched
// came back as `WALLET_PASS_NOT_CREATABLE`. Meanwhile the one thing that would
// have answered the question, `store.findPass`, existed and worked, and the
// issuance route never called it.
// ---------------------------------------------------------------------------

/**
 * The tracking states a request may hand back an existing pass for.
 *
 * Narrow on purpose, and for a reason that is not "these are the good ones":
 *
 * - `issued` — Google has the object and the customer holds it.
 * - `not_saved` — Google was asked and has no object. A gap in **our**
 *   knowledge, not a state the customer is in; the schema comment separates the
 *   two precisely so nobody reads it as "this customer has no pass".
 * - `inactive` — the pass exists and the customer deactivated it. The same pass,
 *   switched off, and `store.ts` documents `inactive → issued` as a real
 *   transition when they switch it back on.
 */
export type ReusablePassState = 'issued' | 'not_saved' | 'inactive';

/**
 * What an existing tracking row means for a request to issue a pass.
 *
 * A union rather than a boolean because the interesting answers are the ones
 * where the route must do something other than mint, and a boolean cannot name
 * which one.
 */
export type ExistingPassDisposition =
  /** No usable pass row: mint, insert, and reconcile, as this route always did. */
  | { kind: 'mint' }
  /** Hand back a freshly signed link for the recorded object. No Google call. */
  | { kind: 'reuse'; state: ReusablePassState; objectId: string }
  /**
   * A terminal state. Refuse, and say so.
   *
   * `expired` and `completed` are terminal because Google cannot undo either, so
   * a new insert would not revive this pass — it would be a **second** object for
   * one customer, and two cards at one counter is a support question with no
   * answer. Minting silently here is the one outcome that must not happen.
   */
  | { kind: 'terminal'; state: 'expired' | 'completed'; objectId: string }
  /**
   * A `state` this build has never heard of.
   *
   * The column is `text` with no `check` constraint, on purpose: the schema says
   * so and says why, namely that readers must fail closed rather than have the
   * database refuse the value. An `else` that minted would turn a value nobody
   * reasoned about into a duplicate card.
   */
  | { kind: 'unknown'; state: string; objectId: string };

/**
 * Decide what a tracking row means before anything is minted.
 *
 * ## Why the tenant is checked here as well as in `findPass`
 *
 * Twice, deliberately, and independently. `customer_wallet_passes.customer_id`
 * is the primary key, so `findPass`'s predicate already narrows to a single row
 * and that row's `tenant_id` still has to be compared — which `findPass` does.
 * This is the second half: the disposition is a pure function over a row, so it
 * must not be possible to hand it a row from another tenant and get back a signed
 * link naming that tenant's object. `classReadinessFor` documents the same
 * pattern — tenant isolation enforced in two independent places, one of which is
 * a test rather than a filter — and this is the same one.
 *
 * ## Why `not_issued` mints rather than reusing
 *
 * The delicate case, and the one worth being explicit about.
 * `recordPass` writes `not_issued`, and it does so whether or not the insert that
 * followed it succeeded. A `not_issued` row is therefore compatible with both
 * "the object is at Google" and "it never got there" — including the case where
 * `reconcilePass` could not reach Google at all and learned nothing.
 *
 * So `not_issued` carries **no information**, and the only honest way to learn
 * whether the object exists is to ask Google. Minting is that: an insert, whose
 * 409 is the answer "it was already there" and whose success is the answer "it
 * was not". Short-circuiting here would hand back a link to an object nobody has
 * confirmed exists — the exact failure that made the insert necessary in the
 * first place, described at length in `routes.ts`.
 *
 * ## Why `not_saved` reuses
 *
 * The mirror image, and the reason the two are separate states at all. `not_saved`
 * is written **only** when Google was asked and answered that it has no object:
 * it is a statement about the world, not about our ignorance. Minting over it
 * would create a second object for one customer on the strength of a gap, and the
 * save token creates the object when the customer taps anyway, so the link is
 * still the right answer.
 */
export function dispositionForExistingPass(
  pass: WalletPassRow | null,
  tenantId: string,
): ExistingPassDisposition {
  if (pass === null) return { kind: 'mint' };

  if (pass.tenantId !== tenantId) return { kind: 'mint' };

  switch (pass.state) {
    case 'issued':
    case 'not_saved':
    case 'inactive':
      return { kind: 'reuse', state: pass.state, objectId: pass.objectId };
    // No information either way — see the note above.
    case 'not_issued':
      return { kind: 'mint' };
    // Terminal: see `ExistingPassDisposition`.
    case 'expired':
    case 'completed':
      return { kind: 'terminal', state: pass.state, objectId: pass.objectId };
    default:
      return { kind: 'unknown', state: pass.state, objectId: pass.objectId };
  }
}

/** An `IssuePassInput` that names the object a tracking row already recorded. */
export interface ExistingPassInput extends IssuePassInput {
  /**
   * `customer_wallet_passes.object_id` — the id that row holds.
   *
   * Not re-derived. `store.ts` states the rule and this is its second reader:
   * the row is the record of what was actually issued, so a link that names a
   * freshly derived id would be a link to a pass this system may never have handed
   * out.
   */
  existingObjectId: string;
}

/**
 * Re-sign a save link for a pass that already exists.
 *
 * ## Why this is cheap enough to be the whole feature
 *
 * `createSaveToWalletUrl` signs a JWT on the fly from the service account and
 * nothing is stored, so re-issuing a link costs one signature. There is no
 * stored token to expire, no row to write, and — crucially — no need to ask Google
 * whether the object is there, because `dispositionForExistingPass` has already
 * answered that from our own tracking state. Not calling Google is not a
 * performance decision here: it is what removes the 409 that used to end in
 * `WALLET_PASS_NOT_CREATABLE`.
 *
 * ## Why nothing is recorded
 *
 * The row that says this pass exists already says so, and its state is not ours
 * to advance from a request that created nothing: `issued` means a Google object
 * exists, and only Google can tell us that. Writing `last_synced_at` here would
 * be worse than writing nothing — it would claim we asked Google when we did not.
 *
 * @throws {MemberCodeUnavailableError} when no usable code could be obtained.
 * @throws {LoyaltyProgramNotConfiguredError} when the tenant has no currency.
 */
export async function linkForExistingPass(
  deps: IssuePassDeps,
  input: ExistingPassInput,
): Promise<IssuedPass> {
  return buildSignedPass(deps, input, input.existingObjectId);
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
