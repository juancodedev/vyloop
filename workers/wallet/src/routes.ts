import { Hono } from 'hono';

import { BalanceNotDisplayableError, balanceDisplayFailure } from './balance';
import { createDrizzleWalletStore, openTenantSession } from './drizzle-store';
import { googleReviewStatusFor, storedReviewStatusFor } from './google-client';
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
  issuePass,
  reasonCodeFor,
 TIER_HEADER_UNAVAILABLE } from './issuance';
import { reconcilePass } from './reconcile';

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
 * - 200 — a link. The pass is built, the member code is stored, the tracking
 *   row is recorded, and the pass is reconciled against Google.
 * - 401 — no auth headers (`UNAUTHORIZED`, from the app-level middleware).
 * - 403 — the token has no customer row in this business.
 * - 409 — the tenant's class is unusable, the tenant has no loyalty program to
 *   name a currency, the deployment is in Demo Mode, or the balance is above
 *   what a pass can display. The code says which.
 * - 500 — this deployment is missing a value it cannot invent.
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
  // Demo mode is no longer a refusal here.
  //
  // It used to be, and the reason was sound: a pass minted against a
  // test-accounts-only deployment does nothing for a real customer, and handing
  // them one is a support incident. But the refusal also made the deployment
  // untestable, because the people who *can* test are the customers the operator
  // added to Google's test-account list — and those hold the `customer` role, not
  // an operator role. This route is self-scoped, so an operator does not even have
  // a customer row to mint from; blocking customers blocked everyone.
  //
  // What keeps a real customer away is not this route but
  // `delivery.contract.test.ts` in the customer web, which forbids any wallet call
  // to action while the issuer is unapproved. The button does not exist, so the
  // route is not reachable from the product. Relaxing the class gate therefore
  // does not expose a customer to anything, because the customer has no way to ask.
  const envDemoMode = parseDemoMode(c.env.WALLET_DEMO_MODE);
  const readiness = classReadinessFor(program, tenantId, envDemoMode);
  if (!readiness.ok) {
    // 409, not 404 and not 500. The prerequisite exists and is known; it is
    // not ready. 404 would tell a client the business has no wallet at all, and
    // 500 would tell it we are broken, and both would be wrong in a way that
    // sends the customer or the operator to the wrong person.
    return c.json({ error: { code: reasonCodeFor(readiness.reason), message: readiness.message } }, 409);
  }

  try {
    const issued = await issuePass(
      {
        store,
        pepper: c.env.MEMBER_CODE_PEPPER,
        serviceAccountEmail: c.env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: c.env.GOOGLE_WALLET_PRIVATE_KEY,
        origins,
      },
      {
        tenantId,
        customerId: customer.id,
        customerGlobalId: customer.globalId,
        customerFullName: customer.fullName,
        storedMemberCode: customer.memberCode,
        issuerId: readiness.issuerId,
        classId: readiness.classId,
      },
    );

    // The pass exists on our side now: a link was signed, a member code was
    // stored and a tracking row was written. Reconciliation asks Google whether
    // the object exists yet and, if it does, projects the ledger's balance onto
    // it. This is the only moment in the request where we depend on Google, and
    // it is deliberately the last thing that happens.
    //
    // `issued.loyaltyObject.id` is asserted against the derived id inside
    // `issuePass`, and this reuses the same object, so there is no third
    // derivation anywhere in the request.
    const client = googleWalletClientFor(c.env);

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

    return c.json({
      data: {
        save_url: issued.saveUrl,
        object_id: issued.objectId,
        class_id: issued.classId,
        member_code: issued.memberCode,
        balance_points: issued.balancePoints,
        points_currency: issued.pointsCurrency,
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

  const program = await store.findProgram(tenantId);
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

export default router;
