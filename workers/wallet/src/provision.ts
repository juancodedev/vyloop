/**
 * Tenant provisioning: create this business's Google class and record it.
 *
 * ## What this is for
 *
 * A tenant is one Google `loyaltyClass` — the shared template every one of its
 * customers' passes points at. Until this existed, the class was created by hand
 * (`docs/11-crear-tarjeta-lealtad.md`) and `insertClass` was a method no
 * production code called: written, tested against a fake, never exercised. Every
 * new business needed someone who knew the procedure, which is a dependency
 * that does not scale past the first handful of merchants.
 *
 * ## The order, which is the whole design
 *
 * **Google first, then the row.** If the `INSERT` fails, what is left behind is
 * a class at Google that no row points at — an orphan, which the next attempt
 * detects by its `409 alreadyExists` and finishes. The other order leaves
 * something much worse: a row declaring a class that does not exist.
 * `classReadinessFor` reads that row, answers `ok: true`, the pass is offered to
 * a customer, and the save fails on their phone minutes later, long after the
 * request that caused it returned 201. An orphan is cleaned by retrying; a false
 * `ok: true` is not recoverable from the customer's side.
 *
 * ## Why the row is written `draft`, in demo mode
 *
 * Because that is the honest starting state, not a placeholder.
 * `tenant_wallet_programs.review_status` defaults to `'none'`, which means "no
 * class" and fails closed — so `'draft'` is written as an explicit value rather
 * than left to the default. `demo_mode` starts `true` because this deployment has
 * no Google's publishing approval, and a tenant that skipped it would hand real
 * customers a pass that only reaches the issuer's own test accounts.
 *
 * ## Idempotency, in both directions
 *
 * The row is read first, and a tenant that already has one costs **zero** Google
 * calls. The 409 is handled as "already there" rather than as a failure, which is
 * what makes the half-finished run above recoverable. Both matter because
 * provisioning runs from a `waitUntil` — a dropped background task, a duplicate
 * delivery and a retry all look the same from here.
 */

import { buildLoyaltyClass } from './class';
import { GoogleWalletApiError } from './google-client';
import type { GoogleWalletClient } from './google-client';
import type { ProgramInsert, WalletStore } from './store';

// ---------------------------------------------------------------------------
// Deps and input
// ---------------------------------------------------------------------------

export interface ProvisionDeps {
  store: WalletStore;
  /** The Google Wallet client. Injected so this is exercisable without a credential. */
  client: GoogleWalletClient;
  /**
   * The Google issuer id this deployment belongs to, from
   * `GOOGLE_WALLET_ISSUER_ID`.
   *
   * Read here, and only here. Every other surface in this worker treats
   * `tenant_wallet_programs.issuer_id` as the authority so that moving issuer is
   * a data change — but a tenant with no row has no authority to consult, and
   * the alternative is inventing an issuer id. This row is written from the
   * deployment's issuer, and every read after it goes through the row.
   */
  issuerId: string;
  /**
   * Gateway origin for the class's `programLogo`. See `parseMediaBaseUrl`.
   *
   * A value, not a policy: this module does not decide what a tenant's public
   * URL is, it only refuses to invent one. Not interchangeable with
   * `webBaseUrl` — the media host has no `/program`.
   */
  mediaBaseUrl: string;
  /**
   * Customer-web origin for the class's `homepageUri`. See `parseWebBaseUrl`.
   *
   * Separate from `mediaBaseUrl` on purpose, and this is where the two hosts are
   * kept apart: Google opens `homepageUri` during review and rejects the class
   * when it 404s, so a media host here produces a class that cannot be
   * approved. `provision.test.ts` asserts the two never cross.
   */
  webBaseUrl: string;
}

export interface ProvisionInput {
  /** `tenants.id` — the tenant whose class is missing. The only tenant this may touch. */
  tenantId: string;
}

/** Why a provisioning run could not finish. Branch on this, not on the message. */
export type ProvisionFailureCode =
  /** No `tenants` row for this id. A lost race, or a caller that named a tenant wrong. */
  | 'tenant_not_found'
  /** No `loyalty_programs` row, or one with a blank name. */
  | 'loyalty_program_not_found'
  /** `buildLoyaltyClass` refused: a required field is blank or an id is invalid. */
  | 'class_payload_invalid'
  /** Google refused the class, or could not be reached or authenticated. */
  | 'google_rejected'
  /** The class exists at Google and the row could not be written. */
  | 'row_write_failed';

export type ProvisionOutcome =
  /** The class was created and the row written. */
  | { kind: 'created'; classId: string }
  /**
   * Google already held the class — a `409 alreadyExists` — and the row is now
   * written. The retry that finishes a run that died between the two writes.
   */
  | { kind: 'already_exists'; classId: string }
  /**
   * The tenant already had a row, so nothing was asked of Google.
   *
   * Carries the `class_id` the row holds rather than one derived again: a row
   * whose id disagrees with the formula is a data defect, and reporting the
   * derived value would report the expected answer instead of the stored one.
   */
  | { kind: 'already_provisioned'; classId: string }
  /**
   * Nothing was recorded. `message` is for a human; `code` and `retryable` are for
   * the caller.
   *
   * ## Why `retryable` is here and not in the caller
   *
   * The caller is the signup path in `workers/identity`, retrying this over a
   * service binding under `waitUntil`. It receives this object and nothing else —
   * not the status code, not the error body — so it cannot tell a Google outage
   * from a payload Google rejected, and guessing would mean spending three
   * `insertClass` calls to learn what one already said.
   *
   * The judgement is therefore made here, next to the error that carries the
   * evidence, and reported. `false` means the answer is a fact about the request
   * or about this business's data, and an identical retry would be rejected the
   * same way.
   */
  | {
      kind: 'failed';
      code: ProvisionFailureCode;
      message: string;
      /** Whether another attempt could produce a different answer. See above. */
      retryable: boolean;
    };

function failed(
  code: ProvisionFailureCode,
  message: string,
  retryable: boolean,
): ProvisionOutcome {
  return { kind: 'failed', code, message, retryable };
}

/**
 * Would a different attempt at the same `insertClass` get a different answer?
 *
 * ## The rule, which is about *who* the answer is about
 *
 * - **No status, no body** — the token exchange failed, the socket did, the DNS
 *   did. Nothing has told us anything about the request, so nothing forbids
 *   trying again. This is the failure the signup retry exists for.
 * - **`429`** — the one 4xx that is a statement about *our rate*, not about the
 *   request. Waiting is exactly the right response, so it is the one 4xx treated
 *   as retryable.
 * - **`5xx`** — a statement about Google. Retryable.
 * - **Any other 4xx** — a statement about the request we sent. The retry is
 *   byte-identical, so it earns nothing and costs a write.
 */
function googleFailureIsRetryable(err: unknown): boolean {
  if (!(err instanceof GoogleWalletApiError)) return true;
  if (err.status === 429) return true;
  return err.status >= 500;
}

/**
 * Is this the one Google error that means "it is already there"?
 *
 * `409` alone is not enough to build on: Google's other conflict is a malformed
 * id, and treating that as success would write a row for a class that will never
 * exist. So the code has to say `alreadyExists` too — which is what the API
 * documents and what the fake in `routes.test.ts` mirrors.
 */
function isAlreadyExists(err: unknown): boolean {
  if (!(err instanceof GoogleWalletApiError)) return false;
  if (err.status !== 409) return false;

  if (err.code === 'alreadyExists') return true;
  return err.errors.some((detail) => detail.reason === 'alreadyExists');
}

/**
 * Create this tenant's Google class and record the program row.
 *
 * Never throws. Every failure is an outcome with a code, because the caller is a
 * `waitUntil` on the signup route: an exception crossing that boundary becomes a
 * rejected background task attributed to an invocation whose visible result was
 * a successful 201, and nothing anywhere says the business has no card.
 */
export async function provisionTenantClass(
  deps: ProvisionDeps,
  input: ProvisionInput,
): Promise<ProvisionOutcome> {
  const { store, client, issuerId, mediaBaseUrl, webBaseUrl } = deps;
  const { tenantId } = input;

  // The cheap exit, before the expensive dependency. Re-running provisioning
  // must not cost a Google call: `insertClass` against an existing id is a 409,
  // so correctness would otherwise depend on Google reporting a conflict.
  const existing = await store.findProgram(tenantId);
  if (existing !== null) {
    return { kind: 'already_provisioned', classId: existing.classId };
  }

  const branding = await store.findTenantBranding(tenantId);
  if (branding === null) {
    return failed(
      'tenant_not_found',
      `No tenants row for ${tenantId}, so there is no merchant name to brand the class with.`,
      // Not retryable: no amount of waiting creates a `tenants` row. This is a lost
      // race or a wrong id, and both are settled by a caller rather than by time.
      false,
    );
  }

  const programName = await store.findProgramName(tenantId);
  if (programName === null) {
    return failed(
      'loyalty_program_not_found',
      `Tenant ${tenantId} has no loyalty_programs row with a name, and Google requires programName.`,
      // A real state during onboarding, and a fact about the business rather than
      // about this call: the row exists or it does not, and a retry reads it again
      // with the same answer.
      false,
    );
  }

  // Read, never invented. `null` means the merchant wrote no promotion, and the
  // class then carries no promo row at all rather than a sentence nobody wrote.
  const promoCopy = await store.findPromoCopy(tenantId);

  let loyaltyClass;
  try {
    loyaltyClass = buildLoyaltyClass({
      issuerId,
      tenantId,
      issuerName: branding.name,
      programName,
      countryCode: branding.country,
      // A class is created in Google's draft state and submitted for review as
      // a separate, deliberate operator step: the transition out of draft is one
      // way, so it is not something a signup should do on a merchant's behalf.
      reviewStatus: 'DRAFT',
      // Keyed by tenant id, so a rebrand replaces the object and Google re-reads
      // it. A business that uploaded nothing resolves to the platform default,
      // which is the case signup produces. The media host, because `/brand/*` is
      // the gateway's route and only the gateway serves it.
      programLogo: { sourceUri: { uri: `${mediaBaseUrl}/brand/${tenantId}.jpg` } },
      // The customer web, because `/program` is the program page and the media
      // host has no such route. Google opens this URL during class review and
      // rejects the class on a 404 — docs/11 records it as the most common
      // rejection reason — so the host is load-bearing, not cosmetic.
      homepageUri: { uri: `${webBaseUrl}/program`, description: 'Programa de lealtad' },
      // The merchant's own sentence, on the class. Google combines class and
      // object text modules, so this does not compete with the object's tier row
      // for its ten slots, and changing a promotion is one class patch instead
      // of one per customer.
      // Conditional rather than `promoCopy ?? undefined`, because this
      // repository has `exactOptionalPropertyTypes` on and the input's
      // `promoCopy` is a plain optional `string`. Same shape `issuance.ts` uses
      // for the same reason.
      ...(promoCopy === null ? {} : { promoCopy }),
      // Both routes are verified to exist by `provision.test.ts`, against the
      // filesystem rather than against this list.
      //
      // Two links are deliberately absent, and their absence is the point:
      //
      // - No "update card" link to `/confirm`. That route exists and renders
      //   "¡Gracias, {name}!", a registration confirmation. A link labelled with
      //   one thing and delivering another is the `homepageUri` defect at a
      //   different URL: nothing 404s, nothing errors, the link is simply a lie.
      // - No referral link. `referrals` records a referrer/referred pair but has
      //   no per-customer code, and `customers.member_code` is a *member* code —
      //   short, tenant-scoped and non-correlational. Presenting it as a referral
      //   code would tell a comensal they can share something that resolves to
      //   nobody. Tracked as a gap, not implemented.
      links: [
        { uri: `${webBaseUrl}/profile`, description: 'Ver mi perfil' },
        { uri: `${webBaseUrl}/profile/history`, description: 'Mi historial' },
      ],
    });
  } catch (err) {
    return failed(
      'class_payload_invalid',
      `Refused to build the class for tenant ${tenantId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      // Deterministic. `buildLoyaltyClass` refuses for a blank name or an invalid
      // id, and both are properties of the data this run just read, so the next
      // attempt builds the identical payload and refuses identically.
      false,
    );
  }

  // Which of the two endings this run had. The class is in the same state either
  // way, and only the record of how it got there differs.
  let alreadyAtGoogle = false;

  try {
    await client.insertClass(loyaltyClass);
  } catch (err) {
    if (!isAlreadyExists(err)) {
      // Nothing is written. This is the assertion the ordering exists for: a row
      // must never outlive a Google class it claims exists.
      return failed(
        'google_rejected',
        `Google did not create the class ${loyaltyClass.id} for tenant ${tenantId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        // The judgement is made from the error itself, not from the code: a
        // `google_rejected` covers both "Google is unwell" and "Google read this
        // request and refused it", and only one of those is worth asking about
        // again. See `googleFailureIsRetryable`.
        googleFailureIsRetryable(err),
      );
    }

    // Carry on to the row. This is the retry for a run that created the class and
    // then failed to record it, and refusing here would leave the tenant
    // permanently unprovisioned with no path back.
    alreadyAtGoogle = true;
  }

  const program: ProgramInsert = {
    tenantId,
    issuerId,
    classId: loyaltyClass.id,
    // Explicit, because the column's default is `'none'`: a value that means
    // "this tenant has no class" and would fail the pass route closed.
    reviewStatus: 'draft',
    demoMode: true,
  };

  try {
    await store.insertProgram(program);
  } catch (err) {
    return failed(
      'row_write_failed',
      `The class ${loyaltyClass.id} exists at Google but the program row for tenant ` +
        `${tenantId} could not be written, so a retry will need to finish it: ${
          err instanceof Error ? err.message : String(err)
        }`,
      // Retryable, and the clearest case in this module: the class is at Google and
      // only the record is missing. The next attempt's `insertClass` is a 409 and
      // the run finishes by writing the row — which is the whole reason the writes
      // are ordered Google-then-row.
      true,
    );
  }

  return alreadyAtGoogle
    ? { kind: 'already_exists', classId: loyaltyClass.id }
    : { kind: 'created', classId: loyaltyClass.id };
}
