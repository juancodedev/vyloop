import { createDb } from '@vyloop/db';
import { Hono } from 'hono';

import { BalanceNotDisplayableError, balanceDisplayFailure } from './balance';
import { applyVerifiedCallback } from './callback-handler';
import type { VerifiedCallbackOutcome } from './callback-handler';
import {
  PassCallbackVerificationError,
  formatCallbackRejection,
  verifyPassCallback,
} from './callbacks';
import type { PassCallbackEvent } from './callbacks';
import { createDrizzleWalletStore, openTenantSession } from './drizzle-store';
import {
  GoogleWalletApiError,
  GoogleWalletAuthError,
  googleReviewStatusFor,
  storedReviewStatusFor,
} from './google-client';
import type { AuthHeaders, WalletBindings } from './helpers';
import {
  extractAuthHeaders,
  googleWalletClientFor,
  parseAllowedOrigins,
  parseDemoMode,
  requireOperatorRole,
} from './helpers';
import {
  LoyaltyProgramNotConfiguredError,
  MemberCodeUnavailableError,
  classReadinessFor,
  dispositionForExistingPass,
  issuePass,
  linkForExistingPass,
  reasonCodeFor,
  TIER_HEADER_UNAVAILABLE } from './issuance';
import { createLocationsSource } from './locations-source';
import type { PushNotification } from './object';
import { reconcilePass, updatePassPushNotifications } from './reconcile';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = new Hono<{ Bindings: WalletBindings; Variables: { auth: AuthHeaders } }>();

// ---------------------------------------------------------------------------
// Stable error codes
// ---------------------------------------------------------------------------

/** The token's own customer row does not exist in this business. */
const CUSTOMER_SELF_NOT_FOUND = 'CUSTOMER_SELF_NOT_FOUND';

/**
 * The worker is missing a value it cannot invent.
 *
 * Distinct from every program-state code on purpose. `WALLET_CLASS_NOT_APPROVED`
 * means "wait for Google, your pass will work"; this means "this deployment is
 * broken and no pass will ever work", and a client that showed the former for
 * the latter would tell a customer to keep waiting for something that will
 * never arrive.
 */
const WALLET_NOT_CONFIGURED = 'WALLET_NOT_CONFIGURED';

/** Google could not be reached, or refused, during an operator sync. */
const WALLET_SYNC_FAILED = 'WALLET_SYNC_FAILED';

/**
 * This deployment has no Google publishing access, so a pass would only reach
 * the issuer's own test accounts.
 *
 * A product condition, not a fault, and not a class-review condition either: it
 * stays true *after* the class is approved, which is precisely why it needs its
 * own code rather than being folded into `WALLET_CLASS_NOT_APPROVED`. A client
 * that showed the latter for this one would tell a customer to wait for a review
 * that has already finished.
 */
const WALLET_DEMO_MODE = 'WALLET_DEMO_MODE';

/**
 * The customer's balance is above what `loyaltyPoints.balance` can display.
 *
 * A product condition. `balance.ts` refuses to truncate rather than show a
 * member `9999999` when they hold 12345678, so this is what that refusal looks
 * like from outside. It used to arrive as a 500, which told the client — and any
 * operator reading the logs — that this deployment is broken. It is not: it is a
 * balance, and the fix is a layout decision for the business (a second balance
 * row, a text module, or a custom layout).
 */
const WALLET_BALANCE_NOT_DISPLAYABLE = 'WALLET_BALANCE_NOT_DISPLAYABLE';

/**
 * The customer's pass reached a state Google will not undo.
 *
 * `customer_wallet_passes.state` is terminal in `expired` and `completed`, and
 * Google cannot un-expire or un-complete an object. So the route refuses instead
 * of minting, because a new insert would not revive this pass: `object_id` is
 * derived from `customers.global_id`, which does not change, so it would be the
 * *same* id being refused — and if it were not, it would be a second card for one
 * customer. Either way the honest answer is a refusal that names the state, not a
 * fresh link that would fail at the customer's phone.
 *
 * 409 and not 500: the prerequisite is known and understood, and nothing about it
 * is broken. What is true is that this pass cannot be reissued, which is a fact
 * about the customer's own pass rather than about the deployment — and saying so
 * is the whole point, because the alternative is a link that does not work.
 */
const WALLET_PASS_TERMINAL = 'WALLET_PASS_TERMINAL';

/**
 * `customer_wallet_passes.state` holds a value this build does not recognise.
 *
 * 500, and deliberately a code of its own rather than a fold into the generic
 * failure. The column is `text` with no `check` constraint precisely so that a
 * future value is a **code** change and readers fail closed until someone decides
 * what it means — see the column's comment in `packages/db/src/schema.ts`. An
 * `else` that minted here would turn a value nobody reasoned about into a
 * duplicate card at a counter, which is the one failure this whole branch
 * exists to prevent. Failing closed is the documented contract, so the response
 * says it happened rather than hiding behind `WALLET_NOT_CONFIGURED`.
 */
const WALLET_PASS_STATE_UNKNOWN = 'WALLET_PASS_STATE_UNKNOWN';

// ---------------------------------------------------------------------------
// POST /v1/wallet/google/callback
// ---------------------------------------------------------------------------

/**
 * The path this worker serves the callback on.
 *
 * ## Why a constant and not the string inline in the registration
 *
 * This path is agreed on by three places that cannot see each other: the route
 * below, the `PUBLIC_PATHS` exemption in `index.ts`, and the `callbackUrl` this
 * worker hands Google — after which no code in this repository decides where
 * Google POSTs, and a class cannot be recreated under the same id. Only one of
 * those three is a route, so writing it inline would leave two declarations with
 * nothing holding them together.
 *
 * The failure that produces is not loud. The two halves are used by different
 * code paths, so renaming one leaves both suites green, and what breaks is a
 * signed webhook answered with a 404 that nobody is reading.
 *
 * It is declared here, in the module that registers the route, rather than in
 * `index.ts` — `index.ts` imports this router, not the other way round, so a
 * constant this file needs has to be declared somewhere it can import without
 * closing an import cycle.
 *
 * ## The other declaration, in another package
 *
 * `apps/gateway/src/robots.ts` declares the same path, and it has to: the
 * gateway is the only public door and must exempt this route from auth, key a
 * rate limit on it, and keep it crawlable. That package does not depend on this
 * one and must not, so the two cannot be derived from each other.
 *
 * `apps/gateway/src/wallet-callback-path.contract.test.ts` closes that gap by
 * reading this file and comparing, and it reads this file rather than importing
 * it for the same reason the gateway does not depend on this package. Do not
 * "simplify" that test into an import: the dependency would point from the
 * public face backwards to the service behind it, and the test would still pass.
 */
export const WALLET_CALLBACK_PATH = '/v1/wallet/google/callback';

/**
 * The one route in this worker with no customer, no token and no tenant header.
 *
 * ## Why it is exempt from the auth middleware
 *
 * `index.ts` runs `extractAuthHeaders` on `*`, so this path is named explicitly
 * there. The exemption is not a relaxation for convenience: the sender is Google,
 * which has no JWT for this system and no `X-Business-Id` to send. What replaces
 * the token is a **signature** over the message, verified before the handler
 * touches a database — the callback carries its own proof of origin, so there is
 * nothing for a bearer token to add.
 *
 * ## Where the endpoint physically lives
 *
 * It is reached through the **gateway**, over the `wallet` service binding, and
 * that is a deliberate layering rather than an accident of the route map:
 *
 * - This worker has no `workers_dev`, no route and no custom domain. It is
 *   unreachable from the internet by configuration, which is the right default
 *   for a worker holding `DATABASE_URL` and Google's service-account key. Adding
 *   a public hostname here to receive webhooks would publish that surface.
 * - The gateway is already the only public door for the routes Google must reach
 *   without credentials: `/brand/*` (a class's `programLogo`) and `/p/*` (the
 *   page a reviewer opens). A callback is the third member of that family.
 * - Keeping the logic here means the signature rules, the tenant resolution and
 *   the state vocabulary stay in the module that owns them, and the gateway
 *   stays a router.
 *
 * ## The status codes, and why each one is chosen
 *
 * Google retries on failure and gives up eventually, so the status *is* the
 * instruction. This mapping is the part of the contract most worth stating:
 *
 * - **`200`** for applied, replayed and unknown-class. All three are final
 *   answers, and a retry would produce exactly the same one. Answering 5xx for
 *   a replay would make Google redeliver a message we have already applied.
 * - **`400`** for a verification failure. The message will never become valid, so
 *   retrying is pure cost — and a `5xx` here would be an unbounded retry loop
 *   against a forgery.
 * - **`500`** only when *we* failed — a database error, an unreachable key
 *   service. That is the one case where a retry is the right instruction, and it
 *   is deliberately the narrowest.
 *
 * ## What is logged
 *
 * The outcome's `kind`, and on rejection its failure `code`. Never the body, the
 * signature, the nonce, or the `objectId` — which embeds `customers.global_id`.
 * A public endpoint's logs get read by people who should not be reading customer
 * identifiers, and the reason code is what a support question actually needs.
 */
router.post(WALLET_CALLBACK_PATH, async (c) => {
  // Read as text, exactly once, and never as JSON. The body is an
  // `ECv2SigningOnly` envelope whose signature covers the *exact bytes* of
  // `signedMessage`, so re-serialising it would produce a different string and
  // the signature would stop verifying — and a `Request` body can only be read
  // once regardless, so a second read would not return the same bytes at all.
  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    return callbackRefusal(
      c,
      400,
      'WALLET_CALLBACK_UNREADABLE',
      'The request body could not be read, so nothing was recorded.',
    );
  }

  // -- Verify, before any database work -----------------------------------
  //
  // This runs against a store with **no** tenant session, because
  // `findTenantByClassId` is a cross-tenant read: working out which tenant a
  // Google class belongs to *is* the question. Opening a tenant session first
  // would admit no rows to it once the tenant RLS policies are enabled, and every
  // callback would resolve to `unknown_class` — a silent total failure rather
  // than an error. Same constraint `sweep.ts` documents for `listProgramTenants`.
  const resolverStore = createDrizzleWalletStore(createDb(c.env.DATABASE_URL));

  let event: PassCallbackEvent;
  try {
    event = await verifyPassCallback(rawBody, { recipientId: c.env.GOOGLE_WALLET_ISSUER_ID });
  } catch (err: unknown) {
    if (err instanceof PassCallbackVerificationError) {
      // A reason code and the diagnostic that goes with it. A code says what
      // failed and never why, and a refusal whose only trace is a code costs a
      // session of guessing every time one occurs.
      console.warn(formatCallbackRejection(err));
      return callbackRefusal(
        c,
        400,
        'WALLET_CALLBACK_UNVERIFIED',
        'The callback signature could not be verified, so nothing was recorded.',
      );
    }
    // The root key service was unreachable, or something genuinely unexpected.
    // 500 is the one instruction that makes Google retry, and it is right here:
    // the message is fine, we could not check it, and a dropped `save` is a
    // customer who never hears they have the pass.
    console.error('[wallet] Could not verify a Google Wallet callback:', err);
    return callbackRefusal(
      c,
      500,
      'WALLET_CALLBACK_UNAVAILABLE',
      'The callback could not be verified, so nothing was recorded. Google will retry.',
    );
  }

  const owner = await resolverStore.findTenantByClassId(event.classId);
  if (owner === null) {
    // Authentic, but naming a class this deployment has no row for. A 200: the
    // answer is final, and a retry would produce exactly the same one.
    console.log('[wallet] Google Wallet callback named a class this deployment does not own.');
    return c.json({ data: { applied: false, reason: 'unknown_class' } });
  }

  // -- From here, every read and write is scoped to that one tenant --------
  const db = await openTenantSession(c.env.DATABASE_URL, owner.tenantId);

  let outcome: VerifiedCallbackOutcome;
  try {
    outcome = await applyVerifiedCallback(
      { store: createDrizzleWalletStore(db), recipientId: c.env.GOOGLE_WALLET_ISSUER_ID },
      event,
    );
  } catch (err: unknown) {
    // Our failure, not Google's. 500 makes Google retry, which is correct: the
    // message was valid and the write did not happen.
    console.error('[wallet] Could not apply a verified Google Wallet callback:', err);
    return callbackRefusal(
      c,
      500,
      'WALLET_CALLBACK_UNAVAILABLE',
      'The callback could not be applied. Google will retry.',
    );
  }

  if (outcome.kind === 'skipped') {
    // 200, and the distinction from a rejection is the point: this message was
    // authentic, it simply has nothing left to do. Retrying changes nothing, and
    // answering 5xx would make Google redeliver a message already handled.
    console.log(`[wallet] Google Wallet callback verified but not applied: ${outcome.reason}.`);
    return c.json({ data: { applied: false, reason: outcome.reason } });
  }

  // No identifier, here or above. See the route's doc comment.
  console.log(
    `[wallet] Google Wallet callback applied: ${outcome.eventType} set the pass to ${outcome.state}.`,
  );
  return c.json({ data: { applied: true, state: outcome.state } });
});

/** A refusal, in this worker's error envelope. */
function callbackRefusal(
  c: { json: (body: unknown, status: 400 | 500) => Response },
  status: 400 | 500,
  code: string,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status);
}

// ---------------------------------------------------------------------------
// GET /v1/wallet/status
// ---------------------------------------------------------------------------

/**
 * GET /v1/wallet/status
 *
 * Whether the authenticated customer can obtain a pass right now, and why not
 * when they cannot.
 *
 * This exists so a client never has to *find out* by trying. The whole design
 * constraint on this surface is that a customer must never be shown an Add to
 * Wallet control that fails, and a client cannot avoid rendering one it does not
 * know to avoid. So the answer to "should I show the button" is its own
 * endpoint, and it is cheap: no signing, no writes, no Google call.
 *
 * Always 200 for an authenticated customer of an existing business, including
 * when a pass is unavailable. A status endpoint that 409s is a status endpoint
 * the client has to special-case, and the whole point is that the client does
 * nothing special. `available: false` with a `reason` is the answer.
 *
 * Only 401-class failures return an error envelope: no auth headers, or no
 * customer row in this business.
 */
router.get('/v1/wallet/status', async (c) => {
  const auth = extractAuthHeaders(c);
  // The tenant is the authenticated business, always. There is no path
  // parameter, no query parameter and no body field that can name a different
  // one, so there is nothing for a caller to tamper with.
  const tenantId = auth.businessId;

  const db = await openTenantSession(c.env.DATABASE_URL, tenantId);
  const store = createDrizzleWalletStore(db);

  const customer = await store.findCustomer(auth.userId, tenantId);
  if (!customer) {
    return c.json(
      {
        error: {
          code: CUSTOMER_SELF_NOT_FOUND,
          message:
            'This account has no customer record in this business, so it has no loyalty pass here.',
        },
      },
      403,
    );
  }

  const program = await store.findProgram(tenantId);
  const demoMode = parseDemoMode(c.env.WALLET_DEMO_MODE);
  const readiness = classReadinessFor(program, tenantId, demoMode);

  // Two reasons to say no that are not about the class at all. Both are asked
  // here rather than discovered by the client failing, because that is the whole
  // purpose of this endpoint: a control must never be rendered over a pass that
  // cannot be obtained.
  //
  // Demo Mode is checked first and on its own. It is a property of the
  // deployment, it survives a class being approved, and every one of its
  // consequences follows from it — so reporting `class_not_approved` alongside it
  // would describe a wait that is not the one the customer is in.
  const balancePoints = readiness.ok
    ? await store.latestBalance(customer.id, tenantId)
    : 0;
  const balanceBlocked = balanceDisplayFailure(balancePoints) !== null;

  const reason = demoMode
    ? 'demo_mode'
    : !readiness.ok
      ? readiness.reason
      : balanceBlocked
        ? 'balance_not_displayable'
        : 'available';

  return c.json({
    data: {
      available: reason === 'available',
      reason,
      // Repeated as data, not only as a 4xx code, so a 200 status response
      // carries the same stable identifier a client would otherwise have to
      // learn by failing first.
      reason_code: reasonCodeForReason(reason),
      // Google's own vocabulary alongside vyloop's storage form. A client that
      // wants to say "under review" must not have to invent the translation.
      review_status: program?.reviewStatus ?? null,
      google_review_status: program === null ? null : googleReviewStatusFor(program.reviewStatus),
      class_id: program?.classId ?? null,
      // When our copy of the review state was last confirmed against Google.
      // A client showing an Add to Wallet control on a months-old `approved` is
      // relying on a cached answer, and this is what makes that visible.
      last_synced_at: program?.lastSyncedAt ?? null,
      has_member_code: customer.memberCode !== null && customer.memberCode !== '',
      // Whether the pass can carry a tier row today. Always false, and asserted
      // by a test: there is no column anywhere to store the row's display
      // header, and inventing one would put hardcoded chrome on a real pass.
      // See TIER_HEADER_UNAVAILABLE.
      tier_row_available: TIER_HEADER_UNAVAILABLE !== null,
      // Whether this deployment still lacks publishing access. Always present,
      // because it is the fact most likely to be missed and most expensive to
      // miss: a pass minted in Demo Mode only reaches the issuer's own test
      // accounts, and a customer told "it is in your wallet" would be told a
      // lie by their own phone. `available` above already accounts for it; this
      // says so explicitly so a client never has to infer it.
      demo_mode: demoMode,
      // The pass row's tracking state, once we have actually asked Google.
      // `not_issued` means we have never checked; `not_saved` means we checked
      // and Google has no object, which is a very different thing to tell a
      // customer. Null when the customer has never been issued a link.
      pass_state: (await store.findPass(customer.id, tenantId))?.state ?? null,
    },
  });
});

/** The stable code for each reason this route can report. */
function reasonCodeForReason(reason: string): string {
  switch (reason) {
    case 'available':
      return 'OK';
    case 'demo_mode':
      return WALLET_DEMO_MODE;
    case 'balance_not_displayable':
      return WALLET_BALANCE_NOT_DISPLAYABLE;
    default:
      return reasonCodeFor(reason as Parameters<typeof reasonCodeFor>[0]);
  }
}

// ---------------------------------------------------------------------------
// GET /v1/wallet/pass
// ---------------------------------------------------------------------------

/**
 * GET /v1/wallet/pass
 *
 * A save-to-wallet link for the authenticated customer, carrying a `LoyaltyObject`
 * that projects the ledger.
 *
 * There is no customer id in the path or the query string. The customer is the
 * token subject, so naming somebody else is not expressible — which is a
 * stronger guarantee than checking a supplied id, because there is no supplied
 * id to check wrongly.
 *
 * Status codes:
 * - 200 — a link. On a first visit the pass is built, the member code is stored,
 *   the tracking row is recorded, the object is created at Google and reconciled
 *   against it. On a returning visit the link is re-signed for the object the
 *   customer's own tracking row records, and nothing is written or asked of
 *   Google — see `dispositionForExistingPass` for the six states and why each one
 *   lands where it does.
 * - 401 — no auth headers (`UNAUTHORIZED`, from the app-level middleware).
 * - 403 — the token has no customer row in this business.
 * - 409 — the tenant's class is unusable, the tenant has no loyalty program to
 *   name a currency, the deployment is in Demo Mode, the balance is above what a
 *   pass can display, the pass is in a terminal state, or Google refused to
 *   create the object. The code says which.
 * - 500 — this deployment is missing a value it cannot invent, or the customer's
 *   pass row holds a state this build does not recognise.
 *
 * ## Why the response says whether the pass already existed
 *
 * Because a reused pass and a freshly minted one are otherwise the same answer:
 * same link, same fields, same 200. `object_id` is identical by design — that is
 * what makes a repeated request idempotent — so a client that cannot read
 * `already_existed` and `pass_state` will tell a customer whose card has been in
 * their phone for a year that it was just added for them. Both fields are needed
 * and they do not contradict each other: `already_existed: false` with
 * `pass_state: "issued"` is a first visit that did create the object, and
 * `already_existed: true` with `pass_state: "not_saved"` is a row that exists
 * and that the customer still has not put in their phone.
 *
 * ## Why a Google call on this route does not threaten the 200
 *
 * Reconciliation is a **side effect** and it cannot fail the request. The
 * pass is built and its link signed before Google is asked anything, and every
 * failure from the reconciliation — an unreachable API, a 403 from a service
 * account that was never invited, a patch Google silently did not apply — is
 * logged and swallowed. The contract that a tap on a button never fails because
 * Google's API is having a bad minute outranks knowing whether the customer
 * saved their pass, and a customer whose pass link failed once will not tap
 * again. `reconcilePass` still throws on a patch that provably did not apply;
 * that is a programming error in the projection, not a runtime condition, and it
 * is logged like the rest.
 */
router.get('/v1/wallet/pass', async (c) => {
  const auth = extractAuthHeaders(c);
  const tenantId = auth.businessId;

  // Checked before any database work: a blank pepper would derive a member code
  // that anyone holding one pass could recompute for every other customer, and
  // an empty `origins` produces an Add to Wallet button that silently does
  // nothing. Both are deployment faults and neither is the customer's problem,
  // so they are reported as such rather than as a program state.
  const origins = parseAllowedOrigins(c.env.WALLET_ALLOWED_ORIGINS);
  if (origins.length === 0) {
    console.error(
      '[wallet] WALLET_ALLOWED_ORIGINS is empty. Google does not render the Add to Wallet button ' +
        'without the origins claim, so no pass can be issued for this deployment.',
    );
    return c.json(
      {
        error: {
          code: WALLET_NOT_CONFIGURED,
          message:
            'Google Wallet passes are not configured for this deployment: no allowed origins are ' +
            'set, and Google requires them to issue a save link.',
        },
      },
      500,
    );
  }

  const db = await openTenantSession(c.env.DATABASE_URL, tenantId);
  const store = createDrizzleWalletStore(db);

  const customer = await store.findCustomer(auth.userId, tenantId);
  if (!customer) {
    return c.json(
      {
        error: {
          code: CUSTOMER_SELF_NOT_FOUND,
          message:
            'This account has no customer record in this business, so it has no loyalty pass here.',
        },
      },
      403,
    );
  }

  // Before the member code is touched and before anything is written. A pass is
  // never built against a class that cannot back it, so this is checked before
  // the first mutation rather than after.
  const program = await store.findProgram(tenantId);
  // The gate asks one question — will Google create an object for this class —
  // and answers it from the review status and the class id's demo marker. Demo
  // mode is passed so the fact travels with the call, but it is **not** part of
  // the answer, and that is deliberate.
  //
  // It used to be. Two ways that went were both wrong: as an allowance it let a
  // `draft` class through to a Google 404 that surfaced as
  // `WALLET_PASS_NOT_CREATABLE` with a "retry in a while" the customer could not
  // act on, and as a refusal it made the deployment untestable, because the
  // people who can test are the customers on Google's test-account list — who
  // hold the `customer` role, and this route is self-scoped, so an operator has
  // no customer row to mint from and blocking customers blocked everyone.
  //
  // What keeps a real customer away from a test-only pass is not this route but
  // `delivery.contract.test.ts` in the customer web, which forbids any wallet call
  // to action while the issuer is unapproved. The button does not exist, so the
  // route is not reachable from the product.
  const envDemoMode = parseDemoMode(c.env.WALLET_DEMO_MODE);
  const readiness = classReadinessFor(program, tenantId, envDemoMode);
  if (!readiness.ok) {
    // 409, not 404 and not 500. The prerequisite exists and is known; it is
    // not ready. 404 would tell a client the business has no wallet at all, and
    // 500 would tell it we are broken, and both would be wrong in a way that
    // sends the customer or the operator to the wrong person.
    return c.json({ error: { code: reasonCodeFor(readiness.reason), message: readiness.message } }, 409);
  }

  // -- What this customer already has --------------------------------------
  //
  // The read that was missing. Without it this route minted on every single
  // visit, which meant every visit of a returning customer produced a Google 409,
  // and every 409 that could not be patched came back as
  // `WALLET_PASS_NOT_CREATABLE` — a symptom of never having looked.
  //
  // It is placed here, after the readiness gate and before anything is written,
  // so a tenant whose class cannot back a pass still costs no extra query, and so
  // a refused request has touched no more than a read.
  const existing = await store.findPass(customer.id, tenantId);
  const disposition = dispositionForExistingPass(existing, tenantId);

  if (disposition.kind === 'terminal') {
    // Refused, loudly, and without a Google call. Minting over a terminal pass is
    // the one outcome that must not happen quietly — see the code's own comment.
    console.warn(
      `[wallet] Refusing to issue: pass ${disposition.objectId} for customer ${customer.id} in ` +
        `tenant ${tenantId} is in terminal state "${disposition.state}".`,
    );
    return c.json(
      {
        error: {
          code: WALLET_PASS_TERMINAL,
          message:
            `This pass is in the state "${disposition.state}" at Google Wallet, and Google does not ` +
            'allow a pass to leave that state, so a new one cannot be issued for it. Your account and ' +
            'your points are unaffected and you can keep using them at the counter. Please tell the ' +
            'business, who can resolve this for you.',
        },
      },
      409,
    );
  }

  if (disposition.kind === 'unknown') {
    // Failing closed, and saying why. An unrecognised `state` is a code change
    // someone has not made yet, not a reason to create a second card.
    console.error(
      `[wallet] Pass ${disposition.objectId} for customer ${customer.id} in tenant ${tenantId} is ` +
        `in unrecognised state ${JSON.stringify(disposition.state)}. Refusing rather than issuing ` +
        'a pass on a state no code in this worker has reasoned about.',
    );
    return c.json(
      {
        error: {
          code: WALLET_PASS_STATE_UNKNOWN,
          message:
            'This pass is recorded in a state this system does not recognise, so it will not issue ' +
            'one on the strength of a state nobody has reviewed. Your account and your points are ' +
            'unaffected.',
        },
      },
      500,
    );
  }

  try {
    const issueDeps = {
      store,
      pepper: c.env.MEMBER_CODE_PEPPER,
      serviceAccountEmail: c.env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
      privateKeyPem: c.env.GOOGLE_WALLET_PRIVATE_KEY,
      origins,
      // Read here, with the session already armed for this tenant, so the pass
      // carries positions only when the customer's consent allows them.
      locations: createLocationsSource(db),
    };
    const issueInput = {
      tenantId,
      customerId: customer.id,
      customerGlobalId: customer.globalId,
      customerFullName: customer.fullName,
      storedMemberCode: customer.memberCode,
      issuerId: readiness.issuerId,
      classId: readiness.classId,
    };

    // Two paths, and they differ only in what they do *after* the object and the
    // link exist. The member code, the ledger balance and the class are read the
    // same way on both, so a re-issued link can never carry a number frozen at
    // some earlier visit.
    const issued =
      disposition.kind === 'reuse'
        ? await linkForExistingPass(issueDeps, {
            ...issueInput,
            // The recorded id, not a fresh derivation. See `store.ts`.
            existingObjectId: disposition.objectId,
          })
        : await issuePass(issueDeps, issueInput);

    // Everything below creates or updates something at Google, so it only runs
    // when this request actually has to issue. A customer who already has a pass
    // gets a freshly signed link for the object their row records and nothing
    // else: no client, no insert, no patch, no reconciliation read.
    //
    // ## Why the reconciliation is skipped along with the insert
    //
    // Because the cost of skipping it is a pass whose balance is one visit stale,
    // and `sweep.ts` already reconciles every due pass on a schedule — including
    // for the customers who never open the app, who are the majority. Paying a
    // Google write on every profile visit to save the sweep one read is the wrong
    // trade, and the insert is what makes it possible at all: the 409 that used to
    // arrive here for every returning customer is what ended in
    // `WALLET_PASS_NOT_CREATABLE`.
    if (disposition.kind === 'mint') {
      // Constructed inside the branch rather than above it. The client is only
      // ever used to reach Google, so building one for a request that will not
      // is a credential-bearing object created for nothing.
      const client = googleWalletClientFor(c.env);

      // Create the object at Google. Nothing before this line had talked to
      // Google about this pass.
      //
      // ## Why this failure is not swallowed, unlike the one below it
      //
      // A save link is a signed claim naming an object id. If no object exists
      // under that id, the link is well-formed and useless: Google answers the
      // customer's tap with "an error occurred, contact the issuer", and our own
      // endpoints reported 200 the whole time. That is exactly what happened for
      // as long as this call did not exist, and it is why the failure mode was
      // invisible for so long.
      //
      // Reconciling a balance and creating a pass are not the same kind of
      // failure, and the swallow below is right for the first and wrong for this
      // one. A stale balance is a cosmetic problem a later sync fixes; a missing
      // object is a promise we cannot keep.
      try {
        await client.insertObject(issued.loyaltyObject);
        console.log(`[wallet] Created pass object ${issued.objectId} at Google.`);
      } catch (err: unknown) {
        if (err instanceof GoogleWalletApiError && err.status === 409) {
          // Two requests that both read "no row" before either wrote it are
          // invisible to each other, and Google's 409 is the only signal that the
          // object is already there. This is no longer the mechanism a returning
          // customer goes through — the pass row is — but it is still the only
          // thing that catches the race, so it stays.
          try {
            await client.patchObject(issued.objectId, issued.loyaltyObject);
            console.log(
              `[wallet] Pass object ${issued.objectId} already existed at Google; patched it instead.`,
            );
          } catch (patchErr: unknown) {
            // Wrapped because this runs inside a `catch`: an exception thrown here
            // would leave the inner handler and reach the route's outer one, which
            // answers a bare 500. The customer would be told the server is broken
            // when the truth is that Google refused the update, which is the same
            // answer the branch above gives.
            const detail =
              patchErr instanceof GoogleWalletApiError || patchErr instanceof GoogleWalletAuthError
                ? patchErr.message
                : 'the update failed for a reason this worker does not classify';
            console.error(`[wallet] Could not patch pass object ${issued.objectId}:`, patchErr);
            return c.json(
              {
                error: {
                  code: 'WALLET_PASS_NOT_CREATABLE',
                  message:
                    'This pass already exists at Google and could not be updated, so no link can be ' +
                    `produced. Google reported: ${detail}`,
                },
              },
              409,
            );
          }
        } else {
          // No cause is asserted here. The previous version of this message told
          // the caller that the class must be approved before an object can be
          // created, which was a guess dressed as a diagnosis: the same branch is
          // also where a failed token exchange lands, because
          // `mintAccessToken` raises `GoogleWalletAuthError` and not
          // `GoogleWalletApiError`. A message that names a cause it has not
          // checked sends the reader to fix the wrong thing.
          const reason =
            err instanceof GoogleWalletApiError || err instanceof GoogleWalletAuthError
              ? err.message
              : 'the Google Wallet client failed for a reason this worker does not classify';
          console.error(`[wallet] Could not create pass object ${issued.objectId}:`, err);
          // 409, not 502 and not 200. The object is not there, so there is no
          // working link to produce, and handing one back anyway is what made this
          // failure invisible for so long.
          return c.json(
            {
              error: {
                code: 'WALLET_PASS_NOT_CREATABLE',
                message:
                  'Google Wallet could not create this pass, so no working link can be produced. ' +
                  `Google reported: ${reason}`,
              },
            },
            409,
          );
        }
      }

      try {
        const outcome = await reconcilePass(
          { store, client, demoMode: envDemoMode },
          { tenantId, customerId: customer.id },
        );

        if (outcome.kind === 'patched') {
          console.log(
            `[wallet] Reconciled pass ${outcome.objectId} to balance ${outcome.balancePoints} for ` +
              `customer ${customer.id} in tenant ${tenantId}.`,
          );
        } else if (outcome.kind === 'not_saved') {
          // The ordinary answer on a first visit: a link was issued, Google has no
          // object, so the customer has not saved it yet. Worth logging because it
          // is the state that was previously indistinguishable from "we never
          // checked", and a merchant asking why a pass is not in a customer's phone
          // is answered by this line.
          console.log(
            `[wallet] Checked Google for pass ${outcome.objectId} and found no object: customer ` +
              `${customer.id} has not saved it yet.`,
          );
        }
      } catch (err: unknown) {
        // Swallowed on purpose, and the reason is in the route's own doc comment:
        // a 200 with a link is a contract that holds. A customer who taps a button
        // and gets an error because Google's API is having a bad minute will not
        // tap it again, and a pass that is one app visit stale is much better than
        // no pass at all. The next reconciliation converges it.
        console.error(
          '[wallet] Pass reconciliation failed; the pass link was still returned:',
          err,
        );
      }
    } else {
      // Logged, because "the customer opened the app and Google was never told
      // anything" is the question this branch answers and it is worth having the
      // answer in the logs. Never the object id, which embeds `global_id` — the
      // rule the callback route documents.
      console.log(
        `[wallet] Reused the existing pass in state "${disposition.state}" for customer ` +
          `${customer.id} in tenant ${tenantId}; no pass object was created.`,
      );
    }

    // What the row says now. On the reused path that is the state it was read in,
    // and nothing has moved it. On the minted path it is whatever the
    // reconciliation managed to learn, so it is read back rather than predicted —
    // a second answer derived from an outcome enum would be a second thing to keep
    // in agreement with the store.
    const passState =
      disposition.kind === 'reuse'
        ? disposition.state
        : ((await store.findPass(customer.id, tenantId))?.state ?? 'not_issued');

    return c.json({
      data: {
        save_url: issued.saveUrl,
        object_id: issued.objectId,
        class_id: issued.classId,
        member_code: issued.memberCode,
        balance_points: issued.balancePoints,
        points_currency: issued.pointsCurrency,
        // Whether **this request** created the pass, as opposed to handing back
        // one that already existed. The response is otherwise identical on both
        // paths — same link, same fields, same 200 — so without this a client
        // cannot tell a customer whose card was just created from one whose card
        // has been in their phone for a year, and the page says "Agregala una vez"
        // to both. It is also the honest answer to "what did this call do?", which
        // `not_saved` and `pass_state` below cannot give on their own.
        already_existed: disposition.kind === 'reuse',
        // `customer_wallet_passes.state` after this request, under the same
        // vocabulary `GET /v1/wallet/status` already reports. Carried here because
        // `already_existed` alone does not separate the three reused states: a pass
        // in `not_saved` genuinely is not in the customer's phone, and telling them
        // it is would be the same lie in the other direction.
        pass_state: passState,
      },
    });
  } catch (err: unknown) {
    if (err instanceof LoyaltyProgramNotConfiguredError) {
      // A real state, and a real prerequisite: the business has a Google class
      // but no loyalty program, so there is no currency to label a balance
      // with. Same 409 family as the class states, and the client already knows
      // to render "not available yet" for this.
      return c.json(
        {
          error: {
            code: 'LOYALTY_PROGRAM_NOT_CONFIGURED',
            message:
              'This business has a Google Wallet pass class but no loyalty program configured, so ' +
              'a pass has no points currency to show. A loyalty program has to be configured first.',
          },
        },
        409,
      );
    }

    if (err instanceof BalanceNotDisplayableError) {
      // 409, and deliberately not 500. This used to fall through to the global
      // error handler, which reported a server fault for what is a product
      // condition about one customer's balance: it is above
      // `loyaltyPoints.balance`'s character budget, `balance.ts` refuses to
      // truncate, and the remedy is a layout decision the business has to make.
      // A 500 would send an operator looking for a broken deployment and a
      // customer to support, and neither can fix it.
      console.error(
        `[wallet] Balance of ${err.points} cannot be displayed on a pass, so none was issued:`,
        err.message,
      );
      return c.json(
        {
          error: {
            code: WALLET_BALANCE_NOT_DISPLAYABLE,
            message:
              'Your points balance is higher than this loyalty pass can show, so a pass has not ' +
              'been issued for you. The business needs to choose a different way to display large ' +
              'balances. Your balance itself is not affected.',
          },
        },
        409,
      );
    }

    if (err instanceof MemberCodeUnavailableError) {
      // Genuinely exceptional: 30 bits of space, a retry loop, and a
      // compare-and-set. Reaching here means something is wrong with the
      // pepper or the row, not that the customer is unready. 500, and the pass
      // was not built.
      console.error('[wallet] Could not obtain a member code:', err);
      return c.json(
        {
          error: {
            code: WALLET_NOT_CONFIGURED,
            message: 'A loyalty pass could not be issued for this account. Please try again.',
          },
        },
        500,
      );
    }

    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /v1/wallet/program  ·  PUT /v1/wallet/program/demo-mode
// ---------------------------------------------------------------------------

/**
 * GET /v1/wallet/program
 *
 * Read this tenant's wallet program as an **operator**.
 *
 * ## Why this exists next to the customer routes
 *
 * `/v1/wallet/status` and `/v1/wallet/pass` are both scoped to the customer
 * named by the bearer token: they resolve `findCustomer(auth.userId)` and
 * refuse with `403 CUSTOMER_SELF_NOT_FOUND` when there is no such row. An
 * operator token has no customer row, so both routes answer 403 to exactly the
 * person who most needs to see the program's state. That is the correct
 * behaviour for the customer routes — a pass belongs to a customer — but it
 * leaves the operator console with nothing to read and a console that looks
 * broken rather than empty.
 *
 * So this is the operator's read path, and it deliberately answers about the
 * **program** rather than about any customer: a tenant row and a role, never a
 * `customerId` from the caller.
 *
 * It reports the effective demo mode, not only the stored value, because the
 * effective value is the one that decides whether a pass mints. See
 * `resolveEffectiveDemoMode` — an operator looking at `demo_mode: false` while
 * `WALLET_DEMO_MODE=true` holds the ceiling would otherwise read it as
 * "production is live" and conclude wrongly.
 */
router.get('/v1/wallet/program', async (c) => {
  const auth = extractAuthHeaders(c);
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }

  const tenantId = auth.businessId;
  const db = await openTenantSession(c.env.DATABASE_URL, tenantId);
  const store = createDrizzleWalletStore(db);

  const program = await store.findProgramWithBusiness(tenantId);
  if (!program) {
    return c.json(
      {
        error: {
          code: 'WALLET_CLASS_NOT_PROVISIONED',
          message:
            'This business has no Google Wallet pass class row, so there is no program state to read. One ' +
            'class per business is created during business onboarding.',
        },
      },
      404,
    );
  }

  // The env var is the ceiling and the row is the tenant's own switch, and a pass
  // mints only when both allow it. An operator looking at `storedDemoMode: false`
  // while the ceiling is on would otherwise read the row as "production is live"
  // and conclude wrongly, so all three values are reported.
  const demoModeCeiling = parseDemoMode(c.env.WALLET_DEMO_MODE);

  return c.json({
    data: {
      tenantId: program.tenantId,
      // The business's own name and slug, joined from `tenants`.
      //
      // These are here because the operator console has no other way to learn
      // which merchant it is acting for: the login response carries `email`,
      // `fullName` and `role` and nothing else, so a screen that needs this
      // merchant's identity had no source for it and fell back to a constant.
      // That constant was one seeded merchant's, on a page mounted in the
      // sidebar, so every merchant who opened it scanned a QR that pointed at
      // somebody else's registration form.
      //
      // Reported verbatim, including a blank slug. A caller that cannot build a
      // public page from an empty slug has to be able to *say* so; substituting
      // a value here would send customers to whichever business that value
      // belonged to, which is the failure this pair of fields exists to remove.
      businessName: program.businessName,
      businessSlug: program.businessSlug,
      classId: program.classId,
      reviewStatus: program.reviewStatus,
      storedDemoMode: program.demoMode,
      demoMode: demoModeCeiling && program.demoMode,
      demoModeCeiling,
      lastSyncedAt: program.lastSyncedAt,
    },
  });
});

/**
 * PUT /v1/wallet/program/demo-mode
 *
 * The operator's demo/production switch: turn pass minting on or off for this
 * tenant, without a redeploy.
 *
 * ## Why the body is required
 *
 * A bare `PUT` would default to `false` and silently switch a live tenant's
 * passes off. The field is required so that a body-less or malformed request
 * cannot do that, and so the intent is always visible in the request log.
 *
 * ## Why the env var still wins
 *
 * This writes the tenant row, and `resolveEffectiveDemoMode` keeps the
 * deployment's ceiling on top. Turning the switch on for a tenant under
 * `WALLET_DEMO_MODE=false` therefore reads back as **still off**, and the
 * response says so with `demoMode`, `storedDemoMode` and `demoModeCeiling`
 * instead of leaving the operator to discover it. The ceiling is a deployment
 * decision, not a tenant one; this route is not the place to change it.
 */
router.put('/v1/wallet/program/demo-mode', async (c) => {
  const auth = extractAuthHeaders(c);
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }

  let body: { demoMode?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: {
          code: 'WALLET_DEMO_MODE_INVALID',
          message:
            'Expected a JSON body of {"demoMode": true} or {"demoMode": false}. A request without an ' +
            'explicit value is refused so that it cannot switch a live tenant off by accident.',
        },
      },
      400,
    );
  }

  if (typeof body.demoMode !== 'boolean') {
    return c.json(
      {
        error: {
          code: 'WALLET_DEMO_MODE_INVALID',
          message:
            '"demoMode" is required and must be a boolean. A request without an explicit value is refused ' +
            'so that it cannot switch a live tenant off by accident.',
        },
      },
      400,
    );
  }

  const tenantId = auth.businessId;
  const db = await openTenantSession(c.env.DATABASE_URL, tenantId);
  const store = createDrizzleWalletStore(db);

  const program = await store.findProgram(tenantId);
  if (!program) {
    return c.json(
      {
        error: {
          code: 'WALLET_CLASS_NOT_PROVISIONED',
          message:
            'This business has no Google Wallet pass class row, so there is no demo mode to switch. One ' +
            'class per business is created during business onboarding.',
        },
      },
      404,
    );
  }

  await store.setProgramDemoMode(tenantId, body.demoMode);
  const updated = await store.findProgram(tenantId);
  const stored = updated?.demoMode ?? body.demoMode;
  const demoModeCeiling = parseDemoMode(c.env.WALLET_DEMO_MODE);

  return c.json({
    data: {
      tenantId,
      storedDemoMode: stored,
      demoMode: demoModeCeiling && stored,
      demoModeCeiling,
      reviewStatus: updated?.reviewStatus ?? program.reviewStatus,
    },
  });
});

// POST /v1/wallet/program/sync
// ---------------------------------------------------------------------------

/**
 * POST /v1/wallet/program/sync
 *
 * Refresh `tenant_wallet_programs.review_status` from Google.
 *
 * ## Why the customer route needs this to exist
 *
 * `GET /v1/wallet/pass` decides on the **stored** review status, deliberately:
 * the customer request path makes no Google call, so a bad minute at Google can
 * never turn into a broken button. The cost of that choice is that our copy of
 * the review state can be stale, and a class Google has since moved out of
 * `APPROVED` would still read as available. This route is the answer to that:
 * it is the only thing permitted to write the review status, it asks Google
 * directly, and an operator has to ask for it.
 *
 * It does **not** create a class. A tenant with no row gets a 404 and stays
 * without one, because the class belongs in tenant onboarding — see
 * `classReadinessFor` for why creating one here would be wrong.
 */
router.post('/v1/wallet/program/sync', async (c) => {
  const auth = extractAuthHeaders(c);
  // Before the program is read, so a 403 here cannot be told apart from the 404
  // an unprovisioned tenant would have produced.
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }

  const tenantId = auth.businessId;
  const db = await openTenantSession(c.env.DATABASE_URL, tenantId);
  const store = createDrizzleWalletStore(db);

  const program = await store.findProgram(tenantId);
  if (!program) {
    // 404, and it names the prerequisite rather than reporting a failure. The
    // sync route cannot help a tenant that has no class row, and inventing one
    // here is exactly what the feature document forbids.
    return c.json(
      {
        error: {
          code: 'WALLET_CLASS_NOT_PROVISIONED',
          message:
            'This business has no Google Wallet pass class row, so there is nothing to sync. One ' +
            'class per business is created during business onboarding; this endpoint never creates one.',
        },
      },
      404,
    );
  }

  const client = googleWalletClientFor(c.env);

  let remote;
  try {
    remote = await client.getClass(program.classId);
  } catch (err: unknown) {
    console.error('[wallet] Google class read failed:', err);
    return c.json(
      {
        error: {
          code: WALLET_SYNC_FAILED,
          message:
            'The Google Wallet class could not be read, so the review status was not updated. ' +
            'Google may be unavailable, or the service account may not have been invited to the ' +
            'issuer account.',
        },
      },
      502,
    );
  }

  // A class that is not there at Google. Reported, not written over: this route
  // refreshes an existing row's review state, and deleting or recreating the
  // row is not something a status refresh should decide.
  if (remote === null) {
    return c.json(
      {
        error: {
          code: 'WALLET_CLASS_NOT_FOUND',
          message: `Google has no class ${program.classId}. The stored row was left untouched.`,
        },
      },
      404,
    );
  }

  const stored = storedReviewStatusFor(remote.reviewStatus);
  if (stored === null) {
    // An unrecognised Google value. Refusing to write keeps the stored status
    // at its last confirmed value rather than replacing a known state with an
    // unknown one that `classReadinessFor` would then treat as blocking.
    return c.json(
      {
        error: {
          code: WALLET_SYNC_FAILED,
          message: `Google reported a review status this system does not recognise (${JSON.stringify(
            remote.reviewStatus ?? null,
          )}). The stored status was left untouched.`,
        },
      },
      502,
    );
  }

  const syncedAt = new Date();
  await store.updateProgramReviewStatus(tenantId, stored, syncedAt);

  return c.json({
    data: {
      class_id: program.classId,
      review_status: stored,
      // A change is worth surfacing: a class moving out of `approved` is the
      // single event that makes every customer of this business lose their
      // pass, and the operator who ran the sync is the one who should see it.
      changed: stored !== program.reviewStatus,
      previous_review_status: program.reviewStatus,
      last_synced_at: syncedAt.toISOString(),
    },
  });
});


// POST /v1/wallet/push-notifications
//
// Update push notifications on the authenticated customer's loyalty pass.
//
// This is called when a campaign is sent, to add a notification to the pass.
router.post('/v1/wallet/push-notifications', async (c) => {
  const auth = extractAuthHeaders(c);
  const tenantId = auth.businessId;

  // Customers can update their own pass; services can push notifications for campaigns
  if (auth.userRole !== 'customer' && auth.userRole !== 'service') {
    return c.json(
      { error: { code: 'FORBIDDEN', message: 'Only customers or services can update push notifications' } },
      403,
    );
  }

  let body: { notifications: PushNotification[]; customer_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'The body must be JSON.' } },
      422,
    );
  }

  const candidate = body as Record<string, unknown>;
  if (!Array.isArray(candidate.notifications)) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'notifications is required and must be an array.' } },
      422,
    );
  }

  const db = await openTenantSession(c.env.DATABASE_URL, tenantId);
  const store = createDrizzleWalletStore(db);

  // For customer role, use the authenticated user's ID
  // For service role, require customer_id in the request body
  let customerId = auth.userId;
  if (auth.userRole === 'service') {
    if (typeof candidate.customer_id !== 'string' || candidate.customer_id.trim() === '') {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'customer_id is required for service role' } },
        422,
      );
    }
    customerId = candidate.customer_id;
  }

  const customer = await store.findCustomer(customerId, tenantId);
  if (!customer) {
    return c.json(
      { error: { code: 'CUSTOMER_SELF_NOT_FOUND', message: 'Customer not found' } },
      404,
    );
  }

  const success = await updatePassPushNotifications(
    { store, client: googleWalletClientFor(c.env), demoMode: false },
    { tenantId, customerId: customer.id },
    body.notifications,
  );

  if (!success) {
    // No issued pass for this customer, or missing program
    return c.json(
      { error: { code: 'PASS_NOT_ISSUED', message: 'Customer has no issued wallet pass' } },
      409,
    );
  }

  return c.json({ ok: true });
});

export default router;
