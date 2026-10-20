import type { MessageBatch } from '@cloudflare/workers-types';
import { checkPasswordPolicy, createDb, hashPassword, schema, verifyPassword } from '@vyloop/db';
import { consume, type EventEnvelope } from '@vyloop/event-bus';
import { requireOperatorRole } from '@vyloop/types';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';

import { counterSubject, isPosPlan, issueToken, issueTokenPair, validateToken, type JwtClaims } from './auth';
import { resolveBranchLocation, type BranchLocation } from './branch-location';
import {
  createBranch,
  deactivateBranch,
  listBranches,
  updateBranch,
} from './branches';
import { signupBusiness, SlugNotDerivableError } from './business-signup';
import { handleTestEvent } from './event-handler';
import { provisionClassWithRetry } from './wallet-provision';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Env {
  JWT_SECRET: string;
  DATABASE_URL: string;
  /**
   * The wallet worker, so a business that just signed up gets its Google class.
   *
   * Optional where `workers/growth` declares the same binding as required, and
   * the reason is that worker: growth only ever reaches `schedulePassReconcile`
   * from handlers that already require a wallet, so its tests carry one. Here,
   * every test that drives this app posts a signup without the binding, and
   * declaring it required would make a missing binding a type error at each of
   * those call sites instead of the runtime condition it actually is. The
   * behaviour is the same either way: absent means "no card yet", never a failed
   * signup.
   */
  WALLET?: WalletWorker;
}

/**
 * The wallet's provisioning surface, as this worker calls it.
 *
 * A plain `Fetcher` models only `fetch` and `connect`, so the target's exported
 * `provisionClass` — the entire point of this binding — needs its own shape. The
 * same declaration `workers/growth` makes for `reconcileCustomer`, for the same
 * reason: the contract is pinned from both sides so renaming the export over
 * there stops this typechecking.
 *
 * The outcome is `unknown` on purpose. This worker does not branch on it: it
 * cannot check whether the class exists, and a second opinion about that would be
 * a second definition of a decision the wallet owns. It logs.
 */
export interface WalletWorker {
  provisionClass(input: { tenantId: string }): Promise<unknown>;
}

type Variables = {
  jwt: JwtClaims;
};

/**
 * The app's context shape, named so the signup route can hand its context to a
 * helper without restating it. `workers/growth` passes a bare
 * `Context<{ Bindings }>` because its router declares no variables and its
 * helpers are called from handlers that would then be uncallable; here the
 * context does carry `jwt`, and the helper is private to this file.
 */
type AppEnv = { Bindings: Env; Variables: Variables };

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// POST /v1/auth/token
// ---------------------------------------------------------------------------

app.post('/v1/auth/token', async (c) => {
  const secret = c.env.JWT_SECRET;
  const dbUrl = c.env.DATABASE_URL;
  if (!secret) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' } }, 500);
  }
  if (!dbUrl) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Database not configured' } }, 500);
  }

  try {
    const body = await c.req.json<{ email?: string; password?: string; grant_type?: string }>();

    if (!body.email || !body.password) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Missing email or password' } },
        401,
      );
    }

    // Create DB connection
    const db = createDb(dbUrl);

      // Find user by email
      //
      // Lowercased, and the counterpart of two decisions that are not visible
      // here. The signup route lowercases before it writes, and `uq_users_email`
      // is a unique index on `lower(email)` rather than on the column, so
      // uniqueness is case-insensitive. This read has to agree with both: without
      // it, an account created as `Ana@example.com` exists and cannot be signed
      // into with that same address, which is the one outcome a login form cannot
      // explain to anyone.
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, String(body.email).toLowerCase()))
        .limit(1);


    if (!user) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid email or password' } },
        401,
      );
    }

    // Verify password
    const isValid = await verifyPassword(body.password, user.passwordHash ?? '');
    if (!isValid) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid email or password' } },
        401,
      );
    }

    const scopes = ['read:customers', 'write:customers', 'write:loyalty', 'read:analytics'];

    const { accessToken, refreshToken, expiresIn } = await issueTokenPair(
      secret,
      user.id,
      user.businessId,
      user.role,
      scopes,
    );

    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('Token issuance error:', err);
    return c.json(
      { error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid credentials' } },
      401,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /v1/auth/refresh
// ---------------------------------------------------------------------------

app.post('/v1/auth/refresh', async (c) => {
  const secret = c.env.JWT_SECRET;
  const dbUrl = c.env.DATABASE_URL;
  if (!secret) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' } }, 500);
  }
  if (!dbUrl) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Database not configured' } }, 500);
  }

  try {
    const body = await c.req.json<{ refresh_token?: string; email?: string }>();

    if (!body.refresh_token || !body.email) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Missing refresh_token or email' } },
        401,
      );
    }

    const db = createDb(dbUrl);
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, body.email))
      .limit(1);

    if (!user) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid email or refresh token' } },
        401,
      );
    }

    const scopes = ['read:customers', 'write:customers', 'write:loyalty', 'read:analytics'];

    const { accessToken, refreshToken, expiresIn } = await issueTokenPair(
      secret,
      user.id,
      user.businessId,
      user.role,
      scopes,
    );

    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    });
  } catch (err) {
    console.error('Token refresh error:', err);
    return c.json(
      { error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid refresh token' } },
      401,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /v1/auth/customer/token — phone-only auth (demo mode, no OTP)
// ---------------------------------------------------------------------------

app.post('/v1/auth/customer/token', async (c) => {
  const secret = c.env.JWT_SECRET;
  const dbUrl = c.env.DATABASE_URL;
  if (!secret) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' } }, 500);
  }
  if (!dbUrl) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Database not configured' } }, 500);
  }

  try {
    const body = await c.req.json<{ phone?: string; otp?: string; businessSlug?: string }>();

    if (!body.phone) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Missing phone number' } },
        401,
      );
    }

    // Normalize phone: strip all whitespace so '+569 5678 9012' matches '+56956789012'
    const normalizedPhone = body.phone.replace(/\s+/g, '');

    const db = createDb(dbUrl);

    // ## The business is required, and an unknown one is an error
    //
    // A phone number is not unique across tenants. The same person is a customer of
    // four different cafés, and `customers` holds one row per (business, phone) —
    // so "log this person in" has no answer until the caller says which business.
    //
    // Previously this refined the lookup only when the tenant was found and
    // otherwise fell through to a global `where phone = ? limit 1`. That limit
    // returns whichever row the database happens to yield first, with no ordering
    // to make it stable, so **the same phone could land in a different café on a
    // different request**. And because the refinement was conditional, **a slug
    // that did not exist produced no error at all**: it issued a valid token for an
    // arbitrary tenant, which is tenant isolation failing silently rather than
    // loudly.
    //
    // Both are refused here instead. A caller that means "this business" and gets
    // a token for another one will render that other café's name and write its QR
    // against a stranger's id, and the cashier scans it.
    if (!body.businessSlug) {
      return c.json(
        {
          error: {
            code: 'AUTH_BUSINESS_REQUIRED',
            message: 'Missing business context. Open the link or QR code of the business.',
          },
        },
        400,
      );
    }

    const [tenant] = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, body.businessSlug))
      .limit(1);

    if (!tenant) {
      return c.json(
        {
          error: {
            code: 'AUTH_BUSINESS_UNKNOWN',
            message: 'Unknown business. Open the link or QR code of the business.',
          },
        },
        404,
      );
    }

    // Scoped to the tenant and nothing else: no fallback, no cross-tenant match.
    const [customer] = await db
      .select()
      .from(schema.customers)
      .where(
        and(
          eq(schema.customers.phone, normalizedPhone),
          eq(schema.customers.businessId, tenant.id),
        ),
      )
      .limit(1);

    if (!customer || customer.deletedAt) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Número no registrado' } },
        401,
      );
    }

    // Demo mode: skip OTP verification when absent
    // In production, validate body.otp here before issuing the token

    // The plan comes from the tenant row this route already loaded, next to the
    // `business_id` the token is scoped to, and never from the body. That matters
    // more here than anywhere else: a phone number is not unique across tenants,
    // so the customer row is found *under* a tenant — `tenant.plan` and
    // `customer.businessId` are describing the same merchant, and a plan read from
    // the request would let a caller pick the limit its own token gets.
    //
    // The gateway's limiter keys on this claim (`DEFAULT_LIMITS` in
    // `apps/gateway/src/middleware/rate-limit.ts`), so without it every customer
    // app request is counted as a token whose plan nobody could identify.
    const token = await issueToken(
      secret,
      customer.globalId,
      customer.businessId,
      'customer',
      ['rewards:read', 'rewards:redeem'],
      tenant.plan,
    );

    return c.json({
      token,
      customer: {
        name: customer.fullName,
        globalId: customer.globalId,
      },
      expiresIn: 3600,
    });
  } catch (err) {
    console.error('Customer token issuance error:', err);
    return c.json(
      { error: { code: 'AUTH_TOKEN_INVALID', message: 'Error al verificar el número' } },
      401,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /v1/auth/pos/token — a merchant's till exchanging its credential
//
// Public, and it has to be: a terminal holds a secret, not a session. The path
// lives under `/v1/auth/` because that prefix is the exemption the gateway grants
// in `apps/gateway/src/index.ts` (`isPublicApiPath`), and widening that exemption
// to reach a new path would hand the whole `/v1/*` surface the same bypass.
//
// ## What it closes
//
// `requireCounterSubject` in `workers/growth/src/helpers.ts` refuses
// `POST /v1/loyalty/checkins` and `POST /v1/loyalty/passes/resolve` to anything
// whose subject is not `pos:<terminalId>` — and nothing in this repository minted
// a `pos:` subject. Both routes therefore had exactly two reachable states: a
// counter, of which there were none, and a refusal. They were built for a terminal
// that had no way to exist, and they are correct as written. This route is the
// other half: a credential that can be exchanged for the one thing they accept.
//
// ## Registration is NOT here
//
// Nothing creates a row in `pos_terminals` yet — no route, no script, no
// dashboard screen. So no terminal can be created through this API and this
// endpoint is unreachable in practice until a writer lands. What *is* complete is
// the verification path, because that is the part that has to be right before
// anything is minted: an unknown id, a wrong secret, a revoked terminal and a
// tenant whose plan does not include POS are all refused. When the writer arrives
// it generates a secret, hashes it with `hashPassword`, writes the row and returns
// the plaintext **once**; nothing here can read it back.
//
// ## Two refusal answers, not one
//
// The credential failures — unknown id, wrong secret, revoked — all answer the
// same status and the same code. That is the point: a distinguishable answer for
// "revoked" is a distinguishable answer for "this id exists", which is half the
// work of enumerating terminals, and the other half is a login endpoint that will
// happily run a PBKDF2 on any id you hand it.
//
// The plan refusal is a different code on purpose. It is not a secret — the
// merchant already knows which plan it is on — and "why does my till not work" is
// a question a human will ask out loud, so it deserves a name it can be answered
// with.
// ---------------------------------------------------------------------------

/** The role a counter's token carries. Free-form text; nothing gates on it today. */
const POS_ROLE = 'pos';

/**
 * What a counter is allowed to be described as.
 *
 * Deliberately not a capability the routes check, and one existing scope. The
 * counter guard on the two loyalty routes reads the **subject**, not the scope
 * and not the role (`isCounterSubject`), because role is free-form text this
 * issuer never enumerates and an allow-list of roles would have to invent a
 * vocabulary. So this list is documentation carried in the token: it names the one
 * thing a till does, and if a counter ever needs more it should be a claim with a
 * check behind it rather than a wider array nobody reads.
 *
 * ## Why a counter's token cannot assign points
 *
 * This is why the role a counter carries matters even though nothing gates on
 * it. `requireOperatorRole` in growth refuses two subjects — a customer, and a
 * counter — using the same `isCounterSubject` predicate that opens the two
 * loyalty routes, so a till's token is stopped on
 * `POST /v1/loyalty/points/assign` with the same code and the same message a
 * customer gets.
 *
 * That guard used to refuse the `customer` role alone, which meant the moment a
 * `pos:` token could exist, it satisfied that guard and could assign points
 * directly — bypassing the earn rule that `POST /v1/loyalty/checkins` exists to
 * apply. Issuing the token and closing that were one change, because the second
 * is what makes the first safe to ship.
 */
const POS_SCOPES = ['write:loyalty'];

app.post('/v1/auth/pos/token', async (c) => {
  const secret = c.env.JWT_SECRET;
  const dbUrl = c.env.DATABASE_URL;
  if (!secret) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' } }, 500);
  }
  if (!dbUrl) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Database not configured' } }, 500);
  }

  let body: { terminal_id?: unknown; secret?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Body must be JSON' } }, 400);
  }

  const terminalId = typeof body.terminal_id === 'string' ? body.terminal_id.trim() : '';
  const presented = typeof body.secret === 'string' ? body.secret : '';

  // 400 and not 401, and the same shape the public signup route uses: the request
  // never described a credential, so there is nothing to authenticate yet. The two
  // older `/v1/auth/*` routes answer 401 for a missing field, which conflates "you
  // sent nothing" with "what you sent is wrong".
  if (!terminalId || !presented) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'terminal_id and secret are required',
        },
      },
      400,
    );
  }

  try {
    const db = createDb(dbUrl);

    const [terminal] = await db
      .select()
      .from(schema.posTerminals)
      .where(eq(schema.posTerminals.id, terminalId))
      .limit(1);

    // One message for every credential failure below, including the "no such
    // terminal" case, so this endpoint cannot be used to learn which terminal ids
    // exist.
    const refused = () =>
      c.json({ error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid terminal credential' } }, 401);

    if (!terminal) {
      return refused();
    }

    // Verified with the same `verifyPassword` that checks `users.password_hash`,
    // against the `saltHex:hashHex` in `key_hash`. The plaintext is never stored,
    // so this is the only comparison that exists — which is why "the secret is
    // hashed" is a property of the row and not a step this route performs.
    //
    // Costs a 100k-iteration PBKDF2 per attempt. That is more work than a
    // high-entropy random secret needs, and it is paid anyway: one credential
    // scheme in this system, with one place that answers "how strong is a
    // credential in this database".
    const matches = await verifyPassword(presented, terminal.keyHash ?? '');
    if (!matches) {
      return refused();
    }

    // **After** the verification, not before, and that ordering is the reason.
    // Checking `revoked_at` first would answer 401 in ~1ms for a revoked terminal
    // and in ~100ms for a live one, so the response time alone would separate "this
    // id exists and was revoked" from "this id exists and is live" — the exact
    // thing the identical response bodies are there to prevent. Verifying first
    // makes the cost of an attempt the same whatever state the row is in.
    if (terminal.revokedAt) {
      return refused();
    }

    const [tenant] = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, terminal.businessId))
      .limit(1);

    // `POS_PLANS` is one named constant, so "which plans include POS" is a
    // one-line change and nothing else. Checked on **every exchange**, not once at
    // creation: a tenant that is downgraded stops renewing its credential
    // immediately, without anybody having to remember which rows to revoke.
    //
    // A terminal whose tenant row is missing is refused with the same answer. The
    // cascade in the schema means that should not happen, and a credential whose
    // merchant no longer exists is not something to mint a token for.
    if (!tenant || !isPosPlan(tenant.plan)) {
      return c.json(
        {
          error: {
            code: 'POS_PLAN_REQUIRED',
            message:
              'This plan does not include POS terminals. Upgrade the plan to register a counter.',
          },
        },
        403,
      );
    }

    // Written only after every check has passed, so `last_seen_at` answers "when
    // did this terminal last succeed" and never "when did somebody try". Awaited
    // rather than handed to `waitUntil`: it is one small write on a path a terminal
    // hits once an hour, and a visit that is not recorded is worth less than a
    // token that takes a few milliseconds longer to arrive.
    await db
      .update(schema.posTerminals)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.posTerminals.id, terminal.id));

    const token = await issueToken(
      secret,
      // `pos:<terminalId>` is what `requireCounterSubject` matches. Minted through
      // the one helper that knows the prefix, so the issuer cannot disagree with
      // the reader about its spelling.
      counterSubject(terminal.id),
      terminal.businessId,
      POS_ROLE,
      POS_SCOPES,
      // Carried so the gateway's limiter counts this terminal at its merchant's
      // plan rather than as a plan nobody could identify.
      tenant.plan,
    );

    // camelCase keys and `expiresIn`, like its sibling
    // `POST /v1/auth/customer/token`: both are consumer credentials exchanged for
    // a single token, not the OAuth-shaped pair the staff routes return.
    return c.json({
      token,
      terminal_id: terminal.id,
      business_id: terminal.businessId,
      expiresIn: 3600,
    });
  } catch (err) {
    // 500 and not a credential refusal. The sibling customer route answers 401
    // here, which turns "the database was unreachable" into "your number is not
    // registered" — a message that sends the customer to re-type a phone number
    // while the actual fault is on our side and invisible.
    console.error('POS token issuance error:', err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /v1/auth/business/signup
//
// Public. The path has to live under `/v1/auth/` for one reason: that prefix is
// the exemption the gateway already grants in `apps/gateway/src/index.ts`
// (auth middleware, business-id resolution and rate limiting all skip it), and
// widening that exemption to reach a new path would hand the whole `/v1/*`
// surface the same bypass. Reusing the prefix costs nothing and touches no
// gateway line.
//
// The same prefix is why this endpoint is unthrottled, and that is worth naming
// rather than discovering: `/v1/auth/*` skips the rate limiter, and the limiter
// is itself keyed on `jwt.business_id`, so it would have no counter to increment
// for a request that carries no JWT. An unauthenticated endpoint that creates
// tenants and runs a 100k-iteration KDF is the shape a script farm looks for.
// The password minimum in `@vyloop/db` is the only control behind it. Moving the
// exemption to a per-route allowlist is the fix; it is not this slice, and it is
// not this file, because the middleware lives in the gateway.
//
// No token is issued. The administrator can log in immediately afterwards, and
// returning one here would quietly route around the known defect in that login
// path — it resolves `users.email` globally while the unique constraint is per
// tenant — by making signup the only way in. That defect is tracked as its own
// change; a signup endpoint that returns a working session is the worst possible
// way to discover it later.
// ---------------------------------------------------------------------------

/**
 * Deliberately permissive. The addresses this endpoint sees are typed by humans
 * into a browser form, and a regex stricter than "looks like an address" rejects
 * real ones far more often than it rejects typos. The database treats
 * `users.email` as opaque text.
 *
 * Case folding is not so much about this endpoint as about the one it feeds.
 * `POST /v1/auth/token` looks the user up with `eq(users.email, body.email)`, a
 * plain equality on stored text — so an address stored as `Owner@x.com` and
 * typed as `owner@x.com` at the login form would not match, and the merchant
 * would be told their credentials are wrong. Storing the folded form here means
 * signup cannot mint an account the login path is unable to find.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmail(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_SHAPE.test(value);
}

/**
 * Ask the wallet to create this tenant's Google class, and do not wait for it.
 *
 * ## Why the call is not on the signup response
 *
 * `provisionClass` reaches `walletobjects.googleapis.com` — a network round trip
 * to the slowest and least reliable dependency this system has — and it is asked
 * for exactly once per business, at the moment a merchant is watching a spinner.
 * Two things go wrong if it blocks:
 *
 * 1. **Latency.** Every signup pays Google's latency, including the days it is
 *    having a bad one.
 * 2. **Availability.** A signup that fails because Google is down throws away a
 *    business that was perfectly registerable, and re-running the form collides
 *    with the slug the first attempt already committed. The business is the
 *    thing the merchant came for; the card is something that can arrive later.
 *
 * So it goes under `waitUntil`, and this function cannot fail. That is the whole
 * contract, and it is why the route calls it *after* `signupBusiness` returns
 * rather than inside the transaction: a `fetch` to Google within
 * `db.transaction` would hold a Neon connection open for the duration of the
 * call, and a failure would have to roll back a tenant that is already good.
 *
 * ## What makes it safe to hand over
 *
 * Everything it does is idempotent: the wallet skips Google entirely when the
 * tenant already has a program row, and treats a `409 alreadyExists` as "already
 * there" and finishes the row. A dropped `waitUntil`, a duplicate delivery and a
 * retry are the same no-op. What a dropped one leaves behind is a business with
 * no card, which the operator's `POST /v1/wallet/program/sync` cannot fix
 * because there is no class to sync — so the honest description of a loss is
 * "this tenant needs provisioning re-run", not "the card will catch up".
 *
 * ## The retry narrows that window; it does not close it
 *
 * `waitUntil` is not durable. It buys this call the seconds the runtime keeps an
 * invocation alive after the response, and a task still running when that window
 * closes is gone without an error. So a single call left a transient Google
 * failure indistinguishable from a permanent one: the business was registered and
 * nothing would ever ask again. `wallet-provision.ts` asks a bounded number of
 * times with a growing backoff, and that is a reduction in the size of the hole,
 * not a plug in it — the daily sweep is what catches what the window drops, and
 * even it is a once-a-day backstop rather than a guarantee.
 *
 * Mirrors `schedulePassReconcile` in `workers/growth`: guard the dispatch,
 * handle the promise before handing it over, and tolerate a context that carries
 * no `ExecutionContext`.
 */
function scheduleWalletProvisioning(c: Context<AppEnv>, tenantId: string): void {
  const wallet = c.env?.WALLET;

  if (!wallet) {
    // Not an error the caller can act on, and not one signup should answer. It
    // is the log line that turns "this business has no card" from a mystery into
    // a thing someone can see and re-run.
    console.error(
      `[identity] No WALLET service binding, so tenant ${tenantId} was registered without a ` +
        'Google class. Provisioning has to be re-run for it.',
    );
    return;
  }

  // The retry lives in its own module, and its own dispatch guard lives with it:
  // a binding that is present but is not a worker throws on the first call, and
  // this runs from inside the route's `try`, so an unguarded throw would be
  // reported as a 500 for a request already committed. It cannot reject either,
  // which is what lets the promise below go to `waitUntil` untouched: a rejected
  // background task is attributed to the invocation that spawned it, and an
  // unhandled rejection is indistinguishable from a real fault in a log somebody
  // has to triage at 06:00.
  const handled = provisionClassWithRetry({ binding: wallet, tenantId });

  // `c.executionCtx` throws when the context carries no `ExecutionContext`, and
  // the callers that do this are the ones driving this app directly rather than
  // the Workers runtime. A business must not depend on which of the two answered.
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }

  if (waitUntil === undefined) {
    console.error(
      `[identity] No ExecutionContext to hand tenant ${tenantId}'s provisioning to, so it runs ` +
        'unattached.',
    );
    return;
  }

  waitUntil(handled);
}

app.post('/v1/auth/business/signup', async (c) => {
  const dbUrl = c.env.DATABASE_URL;
  if (!dbUrl) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Database not configured' } }, 500);
  }

  let body: { name?: unknown; email?: unknown; password?: unknown; full_name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Body must be JSON' } }, 400);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'name is required' } },
      400,
    );
  }

  if (!isEmail(body.email)) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'email must be a valid address' } },
      400,
    );
  }
  const email = body.email.toLowerCase();

  // Checked before the transaction opens, so a rejected password costs no
  // connection and no write. The policy lives in `@vyloop/db` so the length is
  // defined once for every future writer, not restated per route.
  const policy = checkPasswordPolicy(typeof body.password === 'string' ? body.password : '');
  if (!policy.ok) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: policy.message } }, 400);
  }

  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : undefined;

  try {
    const db = createDb(dbUrl);
    const outcome = await signupBusiness(db, {
      name,
      adminEmail: email,
      adminPasswordHash: await hashPassword(body.password as string),
      adminFullName: fullName,
    });

      if (!outcome.ok) {
        if (outcome.code === 'EMAIL_TAKEN') {
          // 409 on the same reasoning as the slug: the request was well formed,
          // and the caller can act on it by using a different address. The
          // message says the address is already registered rather than that a
          // constraint failed, because the constraint is not something the person
          // at the form knows or can do anything about.
          return c.json(
            {
              error: {
                code: 'ADMIN_EMAIL_TAKEN',
                message:
                  'That email address is already registered for another business. One address is ' +
                  'one account, so use a different one to register this business.',
              },
            },
            409,
          );
        }

        // 409, not 400: the request was well formed and the caller can fix it,

      // but not by changing what they sent — they have to change the name, and
      // the slug is derived from the name, so the response has to name the slug
      // they are actually colliding on. Sending them back a message about
      // "Café Central" when they typed "Café Central!" is the whole point.
      return c.json(
        {
          error: {
            code: 'BUSINESS_SLUG_TAKEN',
            message: `A business with the slug "${outcome.slug}" already exists. Choose a different business name.`,
          },
        },
        409,
      );
    }

    // Post-commit, and off the response path. The transaction above has already
    // committed, which is the point: the Google class is an addition to a
    // business that exists, not a fifth write that can fail alongside the other
    // four. `scheduleWalletProvisioning` cannot throw and returns nothing, so
    // nothing below this line can change what the merchant is told.
    scheduleWalletProvisioning(c, outcome.value.businessId);

    return c.json({ data: outcome.value }, 201);
  } catch (err) {
    if (err instanceof SlugNotDerivableError) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: err.message } }, 400);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /v1/me
// ---------------------------------------------------------------------------

app.get('/v1/me', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json(
      { error: { code: 'AUTH_TOKEN_INVALID', message: 'Missing or invalid Authorization header' } },
      401,
    );
  }

  const secret = c.env.JWT_SECRET;
  if (!secret) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' } }, 500);
  }

  try {
    const token = authHeader.slice(7);
    const claims = await validateToken(secret, token);

    return c.json({
      sub: claims.sub,
      business_id: claims.business_id,
      role: claims.role,
      scopes: claims.scopes,
      iat: claims.iat,
      exp: claims.exp,
    });
  } catch {
    return c.json(
      { error: { code: 'AUTH_TOKEN_INVALID', message: 'Token invalid or expired' } },
      401,
    );
  }
});

// ---------------------------------------------------------------------------
// GET /v1/businesses/{id}
// ---------------------------------------------------------------------------

app.get('/v1/businesses/:id', async (c) => {
  const businessId = c.req.param('id');

  // PMV: return minimal tenant info.
  // In production: query the database for tenant details.
  return c.json({
    id: businessId,
    name: `Business ${businessId}`,
    status: 'active',
    // In production, return more fields:
    // plan, country, timezone, currency, createdAt, etc.
  });
});

// ---------------------------------------------------------------------------
// The business's venues
// ---------------------------------------------------------------------------
//
// A venue is a place: a shop, a branch, a counter. Until now the platform had
// a table for them and no way to write to it, so a business could not register
// one and the position it would need to be found nearby could not be recorded.
//
// The four routes below are that missing capability. They live in this worker
// because this worker already serves `/v1/businesses`, which is where a
// business looks for its own places.
//
// ## The tenant comes from the token
//
// Every route here resolves the tenant from the caller's signed token and
// refuses a path that names a different business. The path parameter is never
// the source of the tenant, because a path parameter is something the caller
// typed.
//
// ## The operator question is asked once, in one place
//
// A customer token and a payment terminal's token are both refused, through
// the same guard the loyalty routes use — the predicates themselves live in
// `@vyloop/types`, so there is one definition of what a counter is rather than
// one per worker.
//
// ## The venue's position is not required
//
// A venue can be registered without a position, and the routes say so. A
// business that has not pinned its branches on a map yet should not have to
// invent coordinates to create one, and a venue with no position is a real
// state rather than an incomplete one.
// ---------------------------------------------------------------------------

/**
 * The answer a venue route gives when the caller may not have it.
 *
 * A refusal is one of three things, and they are not interchangeable: the
 * request was not authenticated, the request was authenticated and is not
 * allowed, or the request was allowed and the thing it named is not there.
 */
type VenueAuth =
  | { ok: true; businessId: string }
  | { ok: false; status: 401 | 403 | 404 | 500; code: string; message: string };

/**
 * Resolve who is calling a venue route, and which business they are calling
 * for.
 *
 * The token is validated here rather than read from the headers the gateway
 * injects. Both are the same credential and both are trustworthy, and
 * validating it again costs one signature check and buys the property that a
 * venue route cannot be talked into by anything other than a real token —
 * even if a request reaches this worker without passing through the gateway.
 */
async function authorizeVenueRequest(c: Context<AppEnv>): Promise<VenueAuth> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      ok: false,
      status: 401,
      code: 'AUTH_TOKEN_INVALID',
      message: 'Missing or invalid Authorization header',
    };
  }

  const secret = c.env.JWT_SECRET;
  if (!secret) {
    return {
      ok: false,
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'JWT secret not configured',
    };
  }

  let claims: JwtClaims;
  try {
    claims = await validateToken(secret, authHeader.slice(7));
  } catch {
    return {
      ok: false,
      status: 401,
      code: 'AUTH_TOKEN_INVALID',
      message: 'Token invalid or expired',
    };
  }

  // The same question the loyalty routes ask, answered by the same predicates.
  // A customer redeeming their own points and a terminal reporting a sale are
  // both subjects that exist in the wild and both must not configure a
  // business's venues.
  const gate = requireOperatorRole(
    { userId: claims.sub, userRole: claims.role },
    'This endpoint manages the venues of your business.',
  );
  if (!gate.ok) {
    return { ok: false, status: gate.status, code: gate.code, message: gate.message };
  }

  // The token names the tenant; the path only gets to agree with it.
  //
  // 404 and not 403: a business that asks about a venue belonging to another
  // business should not be able to tell the difference between "that venue does
  // not exist" and "that venue is not yours". Answering 403 would confirm that
  // the identifier exists.
  if (c.req.param('id') !== claims.business_id) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Business not found' };
  }

  return { ok: true, businessId: claims.business_id };
}

/**
 * Read a string field from a JSON body.
 *
 * `undefined` means the caller did not mention the field, which is different
 * from `null`, which means "clear it". The distinction is what lets a partial
 * update change a venue's name without blanking its address.
 */
function readString(body: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in body)) {
    return undefined;
  }
  const value = body[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The first field that was sent but is not a string.
 *
 * `readString` cannot tell those two apart on its own: a field that was not
 * sent and a field that was sent as a number both come back as "nothing to
 * write". Left that way, a request that asked to set an address to `12345`
 * would succeed and write no address — the caller would be told 201 and the
 * venue would have no address at all.
 *
 * `null` is not a wrong type: it is how a field is cleared.
 */
function findNonStringField(body: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    if (!(field in body)) {
      continue;
    }
    const value = body[field];
    if (value === null || typeof value === 'string') {
      continue;
    }
    return field;
  }
  return null;
}

/**
 * The position a request is asking for, or the fact that it is not asking.
 *
 * `undefined` means the request said nothing about the position, so it is left
 * alone. `null` means the request asked for it to be removed. An object means
 * the request asked for it to be set.
 */
function readLocation(
  body: Record<string, unknown>,
):
  | { present: false }
  | { present: true; location: BranchLocation | null; error?: { code: string; message: string } } {
  const mentionsPosition =
    'latitude' in body || 'longitude' in body || 'geohash' in body;

  if (!mentionsPosition) {
    return { present: false };
  }

  const outcome = resolveBranchLocation({
    latitude: body.latitude,
    longitude: body.longitude,
    geohash: body.geohash,
  });

  if (!outcome.ok) {
    if (outcome.code === 'BRANCH_LOCATION_ABSENT') {
      // Every position field was sent as null. That is a request to clear the
      // position, which is a thing a venue can do.
      return { present: true, location: null };
    }
    return {
      present: true,
      location: null,
      error: { code: outcome.code, message: outcome.message },
    };
  }

  return { present: true, location: outcome.location };
}

// ---------------------------------------------------------------------------
// GET /v1/businesses/{id}/branches
// ---------------------------------------------------------------------------

app.get('/v1/businesses/:id/branches', async (c) => {
  const auth = await authorizeVenueRequest(c);
  if (!auth.ok) {
    return c.json({ error: { code: auth.code, message: auth.message } }, auth.status);
  }

  const dbUrl = c.env.DATABASE_URL;
  if (!dbUrl) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Database not configured' } }, 500);
  }

  const db = createDb(dbUrl);
  const venues = await listBranches(db, auth.businessId);

  return c.json({
    branches: venues,
    total: venues.length,
    business_id: auth.businessId,
  });
});

// ---------------------------------------------------------------------------
// POST /v1/businesses/{id}/branches
// ---------------------------------------------------------------------------

app.post('/v1/businesses/:id/branches', async (c) => {
  const auth = await authorizeVenueRequest(c);
  if (!auth.ok) {
    return c.json({ error: { code: auth.code, message: auth.message } }, auth.status);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Body must be JSON' } }, 400);
  }

  const wrongType = findNonStringField(body, ['name', 'address', 'city', 'country', 'timezone']);
  if (wrongType) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: `${wrongType} must be a string` } },
      400,
    );
  }

  const name = readString(body, 'name');
  if (!name) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } }, 400);
  }

  const country = readString(body, 'country');
  if (!country) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'country is required' } }, 400);
  }

  const location = readLocation(body);
  if (location.present && location.error) {
    return c.json(
      { error: { code: location.error.code, message: location.error.message } },
      400,
    );
  }

  const dbUrl = c.env.DATABASE_URL;
  if (!dbUrl) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Database not configured' } }, 500);
  }

  const db = createDb(dbUrl);
  const venue = await createBranch(db, {
    businessId: auth.businessId,
    name,
    address: readString(body, 'address') ?? null,
    city: readString(body, 'city') ?? null,
    country,
    timezone: readString(body, 'timezone') ?? null,
    location: location.present ? location.location : null,
  });

  return c.json({ branch: venue }, 201);
});

// ---------------------------------------------------------------------------
// PATCH /v1/businesses/{id}/branches/{branchId}
// ---------------------------------------------------------------------------

app.patch('/v1/businesses/:id/branches/:branchId', async (c) => {
  const auth = await authorizeVenueRequest(c);
  if (!auth.ok) {
    return c.json({ error: { code: auth.code, message: auth.message } }, auth.status);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Body must be JSON' } }, 400);
  }

  const wrongType = findNonStringField(body, ['name', 'address', 'city', 'country', 'timezone']);
  if (wrongType) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: `${wrongType} must be a string` } },
      400,
    );
  }

  const location = readLocation(body);
  if (location.present && location.error) {
    return c.json(
      { error: { code: location.error.code, message: location.error.message } },
      400,
    );
  }

  const name = readString(body, 'name');
  if (name === null) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'name cannot be empty' } },
      400,
    );
  }

  const dbUrl = c.env.DATABASE_URL;
  if (!dbUrl) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Database not configured' } }, 500);
  }

  const db = createDb(dbUrl);
  const venue = await updateBranch(db, {
    businessId: auth.businessId,
    branchId: c.req.param('branchId'),
    fields: {
      name,
      address: readString(body, 'address'),
      city: readString(body, 'city'),
      country: readString(body, 'country') ?? undefined,
      timezone: readString(body, 'timezone'),
    },
    location: location.present ? location.location : undefined,
  });

  if (!venue) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Venue not found' } }, 404);
  }

  return c.json({ branch: venue });
});

// ---------------------------------------------------------------------------
// DELETE /v1/businesses/{id}/branches/{branchId}
// ---------------------------------------------------------------------------

app.delete('/v1/businesses/:id/branches/:branchId', async (c) => {
  const auth = await authorizeVenueRequest(c);
  if (!auth.ok) {
    return c.json({ error: { code: auth.code, message: auth.message } }, auth.status);
  }

  const dbUrl = c.env.DATABASE_URL;
  if (!dbUrl) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Database not configured' } }, 500);
  }

  const db = createDb(dbUrl);
  const venue = await deactivateBranch(db, {
    businessId: auth.businessId,
    branchId: c.req.param('branchId'),
  });

  if (!venue) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Venue not found' } }, 404);
  }

  return c.json({ branch: venue });
});

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.notFound((c) => {
  return c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  console.error('Identity service error:', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

// ---------------------------------------------------------------------------
// Queue consumer — TestEvent handler
// ---------------------------------------------------------------------------

async function queueHandler(batch: MessageBatch<EventEnvelope>, _env: Env): Promise<void> {
  await consume(batch, handleTestEvent);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default {
  fetch: app.fetch,
  queue: queueHandler,
};
