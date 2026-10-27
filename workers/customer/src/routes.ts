import {
  createDb,
  customers,
  customerEvents,
  consents,
  tenants,
  loyaltyPrograms,
  pointsTransactions,
  membershipTiers,
  customerWalletPasses,
  rewards,
  upsertConsent,
} from '@vyloop/db';
import {
  CUSTOMER_PROFILE_UPDATED,
  CUSTOMER_REGISTERED,
  PROFILE_VIEWED,
  createEnvelope,
  publish,
} from '@vyloop/event-bus';
import { getRequestId } from '@vyloop/request-context';
import { validate } from '@vyloop/schema-registry';
import {
  CUSTOMER_PATCH_ERROR,
  CUSTOMER_PATCHABLE_FIELDS,
  CUSTOMER_SELF_PATCHABLE_FIELDS,
  parseConsentTypes,
  type ParsedConsent,
} from '@vyloop/types';
import { eq, and, isNull, like, or, count, desc, asc, sum, gt, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
// import { HTTPException } from 'hono/http-exception';

import { deleteCustomerAccount } from './account-deletion';
import type { Bindings } from './helpers';
import {
  extractAuthHeaders,
  buildCustomerRegisteredEvent,
  deriveRewardProgress,
  requireOperatorRole,
} from './helpers';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = new Hono<{ Bindings: Bindings }>();

/**
 * Record the consents the caller asked for.
 *
 * The customer and the consents it was registered with are **one write**. A
 * customer who agreed to be contacted and a system that forgot to record it is
 * a customer the business believes it may contact and may not — and the
 * disagreement is invisible until a message is sent or a campaign is run.
 *
 * The consents go in the same transaction as the customer for exactly that
 * reason: either both land or neither does.
 */
async function recordConsents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  customerId: string,
  businessId: string,
  asked: ParsedConsent[],
  ipAddress: string | null,
): Promise<void> {
  for (const consent of asked) {
    await upsertConsent(db, {
      businessId,
      customerId,
      consentType: consent.consentType,
      granted: consent.granted,
      ipAddress,
    });
  }
}

// ---------------------------------------------------------------------------
// Upsert: PUT /v1/customers
// ---------------------------------------------------------------------------

router.put('/v1/customers', async (c) => {
  const body = await c.req.json<{
    fullName: string;
    phone: string;
    email?: string;
    birthDate?: string;
    businessSlug?: string;
    consents?: Record<string, boolean>;
  }>();

  if (!body.fullName || !body.phone) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'fullName and phone are required' } },
      400,
    );
  }

  // Normalize phone: strip whitespace so '+569 5678 9012' is stored as '+56956789012'
  body.phone = body.phone.replace(/\s+/g, '');

  // The consent types are checked before anything is written. A client that
  // sends a type nobody knows is told so, and a rejected registration leaves no
  // customer and no consent behind — which is the only outcome that leaves the
  // caller able to fix it.
  const parsedConsents = parseConsentTypes(body.consents);
  if (!parsedConsents.ok) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsedConsents.message } }, 400);
  }

  const db = createDb(c.env.DATABASE_URL);

  // Resolve businessId: from auth headers (JWT flow) or businessSlug (public registration)
  let businessId: string;
  let auth: ReturnType<typeof extractAuthHeaders> | null = null;
  try {
    auth = extractAuthHeaders(c);
  } catch {
    auth = null;
  }

  if (auth) {
    // With a token this is the staff creating a customer from the dashboard.
    // The customer app registers without one, through the branch below.
    const gate = requireOperatorRole(auth);
    if (!gate.ok) {
      return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
    }
    businessId = auth.businessId;
  } else {
    // No auth headers — must be public registration with businessSlug
    if (!body.businessSlug) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'businessSlug is required for public registration',
          },
        },
        400,
      );
    }

    const [tenant] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, body.businessSlug))
      .limit(1);

    if (!tenant) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `Business "${body.businessSlug}" not found` } },
        404,
      );
    }
    businessId = tenant.id;
  }

  // Check if a customer already exists for this business + phone
  const existing = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.businessId, businessId),
        eq(customers.phone, body.phone),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    // Update existing — skip event
    const customer = existing[0];
    const updateData: Partial<typeof customers.$inferInsert> = {
      fullName: body.fullName,
      updatedAt: new Date(),
    };
    if (body.email !== undefined) updateData.email = body.email;
    if (body.birthDate !== undefined) updateData.birthDate = body.birthDate;

    // The repeat-registration branch writes to the same unique indexes as the
    // insert below, so it needs the same classification. It had none, which meant a
    // returning customer who supplied an email already used in this business got
    // `500 INTERNAL_ERROR` — while the first-time registration of the same pair
    // answered 409. One route, one index, two opposite answers depending on which
    // branch the customer happened to land in.
    let updatedRows: (typeof customers.$inferSelect)[];
    try {
      updatedRows = await db.transaction(async (tx) => {
        const rows = await tx
        .update(customers)
        .set(updateData)
        .where(eq(customers.id, customer.id))
        .returning();
        await recordConsents(
          tx,
          customer.id,
          businessId,
          parsedConsents.consents,
          c.req.header('CF-Connecting-IP') ?? null,
        );
        return rows;
      });
    } catch (err) {
      const conflict = classifyUniqueViolation(
        err,
        REGISTRATION_UNIQUE_MESSAGES,
        REGISTRATION_GENERIC_CONFLICT,
      );
      if (!conflict) throw err;
      return c.json({ error: { code: conflict.code, message: conflict.message } }, 409);
    }

    const [updated] = updatedRows;
    return c.json(updated, 200);
  }

  // Insert new customer — first-time registration
  const insertData: typeof customers.$inferInsert = {
    businessId,
    phone: body.phone,
    fullName: body.fullName,
  };
  if (body.email) insertData.email = body.email;
  if (body.birthDate) insertData.birthDate = body.birthDate;

  // A duplicate email in the same business is a conflict, not a server fault.
  //
  // `uq_customers_business_email` is UNIQUE on (business_id, email) and the upsert
  // above only looks the customer up by phone, so this insert can violate it. The
  // violation was unhandled and reached the top-level handler as a `500`, which is
  // the one answer a registering customer cannot act on: the field is optional on
  // the form, people reuse their own address, and "internal server error" reads as
  // "try again", which fails identically every time.
  //
  // 409 rather than 400, for the same reason `PATCH` uses it: the request was
  // well-formed and the business's own data is what conflicts with it.
  let insertedRows: (typeof customers.$inferSelect)[];
  try {
    insertedRows = await db.transaction(async (tx) => {
      const rows = await tx.insert(customers).values(insertData).returning();
      const registered = rows[0];
      await recordConsents(
        tx,
        registered.id,
        businessId,
        parsedConsents.consents,
        c.req.header('CF-Connecting-IP') ?? null,
      );
      return rows;
    });
  } catch (err) {
    const conflict = classifyUniqueViolation(
      err,
      REGISTRATION_UNIQUE_MESSAGES,
      REGISTRATION_GENERIC_CONFLICT,
    );
    if (!conflict) throw err;
    return c.json({ error: { code: conflict.code, message: conflict.message } }, 409);
  }

  // Destructured as before, from an array rather than a `| undefined` binding: an
  // INSERT's `RETURNING` yields the row it wrote, and widening this to "possibly
  // absent" would only have moved the question to the event builder below.
  const [inserted] = insertedRows;

  // ---------------------------------------------------------------------------
  // Past this point nothing may turn a committed write into a failed registration.
  //
  // `ajv.compile()` builds validators with `new Function()`, which Cloudflare
  // Workers forbids, so `validate()` throws `EvalError: Code generation from
  // strings disallowed for this context` on every call — in production, on every
  // single registration. There is no compatibility flag that changes this:
  // `allow_eval_during_startup` covers module startup, and this compile happens
  // per request, inside the handler.
  //
  // The previous ordering reported `500 INTERNAL_ERROR` for a customer that had
  // already been inserted. The row committed and then the response denied it. A
  // retry took the upsert branch above and returned 201, so a total outage read
  // as a flake — which is how this survived as long as it did.
  //
  // The customer exists. That is a fact this response now reports, and it is not
  // negotiable by a later side effect. Whether the event reached the queue is a
  // different fact with a different owner: an unpublished event is a
  // reconciliation problem, not a customer who failed to register, and collapsing
  // the two is what made the original failure invisible.
  // ---------------------------------------------------------------------------
  const event = buildCustomerRegisteredEvent(inserted, businessId, getRequestId(c));

  // Two distinct questions, deliberately kept apart.
  //
  // `payloadValid` is "did the schema accept this". It is a property of the event
  // and it still gates publication: a payload the registry rejects must not reach
  // the queue, exactly as before this change.
  //
  // `threw` is "could we even ask". In production today that is the normal answer,
  // because `validate()` cannot compile a validator in this runtime. It is not
  // evidence that the payload is valid, so it must not be reported as validation
  // passing — but an unavailable validator is not a reason to withhold the event
  // either, or the queue would go silent for every registration for as long as
  // Ajv stays in place.
  let payloadValid = true;
  try {
    const schemaResult = await validate(c.env.SCHEMA_REGISTRY, CUSTOMER_REGISTERED, event.payload);
    if (!schemaResult.valid) {
      payloadValid = false;
      console.error('[customer] Event payload failed schema validation:', schemaResult.errors);
    }
  } catch (err) {
    // Surfaced rather than swallowed. This branch is the current state of this
    // code in production, and it is the signal that schema validation has not in
    // fact been running for any registration.
    console.error('[customer] Schema validation unavailable:', err);
  }

  let eventPublished = false;
  if (payloadValid) {
    try {
      await publish(c.env.DOMAIN_EVENTS_QUEUE, event);
      eventPublished = true;
    } catch (err) {
      console.error('[customer] Failed to publish customer.registered:', err);
    }
  }

  return c.json({ ...inserted, event_published: eventPublished }, 201);
});

// ---------------------------------------------------------------------------
// List: GET /v1/customers
// ---------------------------------------------------------------------------

router.get('/v1/customers', async (c) => {
  const auth = extractAuthHeaders(c);
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const q = c.req.query('q') || '';
  const offset = (page - 1) * limit;

  const db = createDb(c.env.DATABASE_URL);

  // Base conditions: RLS scope + active customers only
  const conditions: SQL[] = [eq(customers.businessId, businessId), isNull(customers.deletedAt)];

  // Apply search if query is provided
  if (q.trim()) {
    const tokens = q.trim().split(/\s+/).filter(Boolean);
    const tokenConditions = tokens.map((token) =>
      or(
        like(customers.fullName, `%${token}%`),
        like(customers.email, `%${token}%`),
        like(customers.phone, `%${token}%`),
      ),
    );
    // Filter out undefined and push
    conditions.push(...tokenConditions.filter((c): c is SQL => c !== undefined));
  }

  const where = and(...conditions);

  // Run count + data queries in parallel
  // NOTE: Points are fetched separately via raw SQL because Drizzle ORM
  // with @neondatabase/serverless mishandles correlated subqueries in
  // .select() — it returns 0 instead of the actual balance.
  const [totalResult, data, pointsResult] = await Promise.all([
    db.select({ total: count() }).from(customers).where(where),
    db
      .select({
        id: customers.id,
        globalId: customers.globalId,
        businessId: customers.businessId,
        phone: customers.phone,
        email: customers.email,
        fullName: customers.fullName,
        birthDate: customers.birthDate,
        identityDoc: customers.identityDoc,
        identityType: customers.identityType,
        language: customers.language,
        optedInAt: customers.optedInAt,
        lastVisitAt: customers.lastVisitAt,
        currentTierId: customers.currentTierId,
        metadata: customers.metadata,
        deletedAt: customers.deletedAt,
        createdAt: customers.createdAt,
        updatedAt: customers.updatedAt,
      })
      .from(customers)
      .where(where)
      .limit(limit)
      .offset(offset)
      .orderBy(customers.createdAt),
    // Fetch latest balance + total earned per customer in one pass
    db.execute(sql`
      SELECT
        customer_id,
        COALESCE(MAX(balance_after) FILTER (WHERE rn = 1), 0)::integer as points,
        COALESCE(SUM(points) FILTER (WHERE type IN ('earn', 'earned')), 0)::integer as total_earned
      FROM (
        SELECT
          pt.customer_id, pt.balance_after, pt.points, pt.type,
          ROW_NUMBER() OVER (PARTITION BY pt.customer_id ORDER BY pt.created_at DESC) as rn
        FROM points_transactions pt
        WHERE pt.business_id = ${businessId}
      ) ranked
      GROUP BY customer_id
    `),
  ]);

  const total = totalResult[0]?.total ?? 0;

  // Merge points into customer rows
  const pointsMap = new Map<string, { points: number; totalEarned: number }>();
  for (const row of (pointsResult.rows ?? []) as Array<{
    customer_id: string;
    points: number;
    total_earned: number;
  }>) {
    pointsMap.set(row.customer_id, {
      points: row.points,
      totalEarned: row.total_earned,
    });
  }

  for (const customer of data) {
    const p = pointsMap.get(customer.id);
    (customer as Record<string, unknown>).points = p?.points ?? 0;
    (customer as Record<string, unknown>).totalPointsEarned = p?.totalEarned ?? 0;
  }

  return c.json({ data, total, page, limit });
});

// ---------------------------------------------------------------------------
// Self-profile: GET /v1/customers/me
// MUST be registered BEFORE /:id to avoid Hono treating "me" as an :id param.
// ---------------------------------------------------------------------------

router.get('/v1/customers/me', async (c) => {
  const userId = c.req.header('X-User-Id'); // globalId from JWT sub
  const businessId = c.req.header('X-Business-Id');

  if (!userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing X-User-Id header' } }, 401);
  }

  if (!businessId) {
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Missing X-Business-Id header' } },
      401,
    );
  }

  const db = createDb(c.env.DATABASE_URL);

  // Look up customer by globalId + businessId
  const [customer] = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.globalId, userId),
        eq(customers.businessId, businessId),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);

  if (!customer) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Customer not found' } }, 404);
  }

  // Fetch balance, total earned, events, recent transactions, last-30-days
  // points, and the loyalty "pass" context (business, program, tiers, rewards).
  const [
    balanceResult,
    earnedResult,
    eventsResult,
    txResult,
    points30Result,
    businessResult,
    programResult,
    tiersResult,
    rewardsResult,
  ] = await Promise.all([
    // Latest balance (uses customer.id PK — matches FK on points_transactions)
    db
      .select({ balance_after: pointsTransactions.balanceAfter })
      .from(pointsTransactions)
      .where(eq(pointsTransactions.customerId, customer.id))
      .orderBy(desc(pointsTransactions.createdAt))
      .limit(1),
    // Total points earned (sum of all 'earn'/'earned' transactions)
    db
      .select({ total: sum(pointsTransactions.points) })
      .from(pointsTransactions)
      .where(
        and(
          eq(pointsTransactions.customerId, customer.id),
          or(eq(pointsTransactions.type, 'earn'), eq(pointsTransactions.type, 'earned')),
        ),
      ),
    // Last 10 customer events
    db
      .select()
      .from(customerEvents)
      .where(eq(customerEvents.customerId, customer.id))
      .orderBy(desc(customerEvents.createdAt))
      .limit(10),
    // Last 5 points transactions for activity timeline
    db
      .select({
        id: pointsTransactions.id,
        type: pointsTransactions.type,
        points: pointsTransactions.points,
        balanceAfter: pointsTransactions.balanceAfter,
        note: pointsTransactions.note,
        purchaseAmount: pointsTransactions.purchaseAmount,
        createdAt: pointsTransactions.createdAt,
      })
      .from(pointsTransactions)
      .where(eq(pointsTransactions.customerId, customer.id))
      .orderBy(desc(pointsTransactions.createdAt))
      .limit(5),
    // Points earned in last 30 days
    db
      .select({ total: sum(pointsTransactions.points) })
      .from(pointsTransactions)
      .where(
        and(
          eq(pointsTransactions.customerId, customer.id),
          or(eq(pointsTransactions.type, 'earn'), eq(pointsTransactions.type, 'earned')),
          sql`${pointsTransactions.createdAt} >= now() - interval '30 days'`,
        ),
      ),

    // ------------------------------------------------------------------
    // Loyalty "web pass" context.
    //
    // There is NO row-level security on these tables: enableRls() and
    // createRlsPolicies() in packages/db/src/rls.ts are never applied by any
    // migration, and no route calls withRls. Tenant isolation therefore rests
    // ENTIRELY on an explicit business filter in every query below. Removing
    // one of these filters would leak another tenant's program and tiers.
    // ------------------------------------------------------------------

    // Business (tenant). `tenants.id` IS the business id — the table is the
    // root of the model and has no business_id column, so scope by primary key.
    db
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, businessId))
      .limit(1),

    // Loyalty program. businessId is UNIQUE here, so at most one row can match.
    // Only id/name/pointsCurrency are exposed — earnRate, minRedeemPoints and
    // pointsExpiryDays are intentionally not surfaced to the customer app.
    db
      .select({
        id: loyaltyPrograms.id,
        name: loyaltyPrograms.name,
        pointsCurrency: loyaltyPrograms.pointsCurrency,
      })
      .from(loyaltyPrograms)
      .where(eq(loyaltyPrograms.businessId, businessId))
      .limit(1),

    // All tiers for this business, canonical display order.
    db
      .select({
        id: membershipTiers.id,
        name: membershipTiers.name,
        minPoints: membershipTiers.minPoints,
        multiplier: membershipTiers.multiplier,
        displayOrder: membershipTiers.displayOrder,
      })
      .from(membershipTiers)
      .where(eq(membershipTiers.businessId, businessId))
      .orderBy(asc(membershipTiers.displayOrder), asc(membershipTiers.minPoints)),

    // Active rewards for this business. Activeness lives in SQL: not deleted,
    // inside its validity window, and not sold out. The business filter is the
    // tenant guarantee, as above.
    db
      .select({ id: rewards.id, name: rewards.name, pointsCost: rewards.pointsCost })
      .from(rewards)
      .where(
        and(
          eq(rewards.businessId, businessId),
          isNull(rewards.deletedAt),
          or(isNull(rewards.validFrom), sql`${rewards.validFrom} <= now()`),
          or(isNull(rewards.validUntil), sql`${rewards.validUntil} > now()`),
          or(isNull(rewards.stock), gt(rewards.stock, 0)),
        ),
      ),
  ]);

  const points = balanceResult[0]?.balance_after ?? 0;
  const totalPointsEarned = Number(earnedResult[0]?.total ?? 0);
  const pointsLast30Days = Number(points30Result[0]?.total ?? 0);

  // Resolve tier name if customer has a tier assigned
  let tier: { id: string; name: string; multiplier: number } | null = null;
  if (customer.currentTierId) {
    const [tierRow] = await db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.id, customer.currentTierId))
      .limit(1);

    if (tierRow) {
      tier = {
        id: tierRow.id,
        name: tierRow.name,
        multiplier: Number(tierRow.multiplier),
      };
    }
  }

  // ------------------------------------------------------------------
  // Loyalty "web pass" payload.
  // ------------------------------------------------------------------

  // Business: null when the tenant row cannot be resolved. Returning null (not
  // throwing) keeps the profile renderable for a customer whose tenant is gone.
  const [businessRow] = businessResult;
  const business = businessRow
    ? { id: businessRow.id, name: businessRow.name, slug: businessRow.slug }
    : null;

  // Program: null when the tenant has no program yet, so the UI can say
  // "your program is being set up" instead of rendering a fabricated name.
  const [programRow] = programResult;
  const program = programRow
    ? {
        id: programRow.id,
        name: programRow.name,
        pointsCurrency: programRow.pointsCurrency,
      }
    : null;

  // NOTE: `multiplier` is numeric(4,2), which Drizzle returns as a STRING.
  // These new fields normalise it to a number. The pre-existing `tier` object
  // below/above still leaks the string form — that inconsistency is left in
  // place on purpose because changing it would be a breaking contract change.
  const tiers = tiersResult.map((t) => ({
    id: t.id,
    name: t.name,
    minPoints: t.minPoints,
    multiplier: Number(t.multiplier),
    displayOrder: t.displayOrder,
  }));

  // nextTier is derived HERE, on the server, on purpose: the rule has exactly
  // one owner and the client only renders what it is told. The first tier in
  // canonical order whose minPoints is strictly greater than the current
  // balance; null when the customer is at or above the top tier.
  const nextTier = tiers.find((t) => t.minPoints > points) ?? null;

  // Same ownership for the reward rule: see deriveRewardProgress.
  const rewardProgress = deriveRewardProgress(rewardsResult, points);

  // numeric(12,2) arrives as a string; the contract is number or null.
  // A missing or unreadable amount is null, never NaN.
  const recentTransactions = txResult.map((tx) => {
    const amount = tx.purchaseAmount == null ? Number.NaN : Number(tx.purchaseAmount);
    return { ...tx, purchaseAmount: Number.isFinite(amount) ? amount : null };
  });

  // Fire-and-forget: record profile_viewed event for dashboards
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await db.insert(customerEvents).values({
          businessId,
          customerId: customer.id,
          eventType: 'customer.profile_viewed',
          payload: {},
        });
        await publish(
          c.env.DOMAIN_EVENTS_QUEUE,
          createEnvelope(
            PROFILE_VIEWED,
            {
            business_id: businessId,
            timestamp: new Date().toISOString(),
            request_id: getRequestId(c),
            },
            {
            customer_id: customer.globalId,
            },
          ),
        );
      } catch (err) {
        console.error('[customer] Failed to emit profile_viewed event:', err);
      }
    })(),
  );

  return c.json({
    data: {
      id: customer.id,
      globalId: customer.globalId,
      fullName: customer.fullName,
      phone: customer.phone,
      email: customer.email,
      birthDate: customer.birthDate,
      points,
      totalPointsEarned,
      pointsLast30Days,
      currentTierId: customer.currentTierId,
      currentTier: tier?.name ?? null,
      tier,
      business,
      program,
      tiers,
      nextTier,
      ...rewardProgress,
      customer_events: eventsResult,
      recent_transactions: recentTransactions,
      createdAt: customer.createdAt,
    },
  });
});

// ---------------------------------------------------------------------------
// Self update: PATCH /v1/customers/me
// MUST be registered BEFORE /:id, like GET /me. The gateway requires the
// `profile:write` scope before the request gets here.
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/**
 * The furthest any time zone runs ahead of UTC (UTC+14). A date counts as begun
 * once it has begun somewhere, so a customer east of UTC can enter today's date.
 */
const MAX_UTC_OFFSET_MS = 14 * 60 * 60 * 1000;

/** A real calendar date, not in the future. `1990-02-30` is refused, not rolled over. */
function isPastCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real && date.getTime() <= Date.now() + MAX_UTC_OFFSET_MS;
}

const SELF_EMAIL_TAKEN = {
  code: CUSTOMER_PATCH_ERROR.EMAIL_TAKEN,
  message: 'Another customer of this business already uses this email address. Use a different one.',
};

function selfValidationError(message: string) {
  return { error: { code: 'VALIDATION_ERROR', message } };
}

router.patch('/v1/customers/me', async (c) => {
  // The customer is the token's subject in the token's business. No id in the
  // path or the body can name anyone else.
  const userId = c.req.header('X-User-Id');
  const businessId = c.req.header('X-Business-Id');
  if (!userId || !businessId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing identity headers' } }, 401);
  }

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return c.json(selfValidationError('The request body is not valid JSON.'), 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return c.json(selfValidationError('The request body must be a JSON object of fields to change.'), 400);
  }
  const body = parsed as Record<string, unknown>;

  // Refused, never filtered: a silently dropped `phone` reads as "saved".
  const editable = new Set<string>(CUSTOMER_SELF_PATCHABLE_FIELDS);
  const rejected = Object.keys(body).filter((field) => !editable.has(field));
  if (rejected.length > 0) {
    return c.json(
      selfValidationError(
        `These fields cannot be changed here: ${rejected.join(', ')}. ` +
          `You can change ${CUSTOMER_SELF_PATCHABLE_FIELDS.join(', ')}. Nothing was saved.`,
      ),
      400,
    );
  }
  if (Object.keys(body).length === 0) {
    return c.json(
      selfValidationError(`Send at least one of ${CUSTOMER_SELF_PATCHABLE_FIELDS.join(', ')}.`),
      400,
    );
  }

  // Same rule as the staff edit: absent means untouched, null means clear.
  const updateData: Record<string, string | null> = {};

  if ('fullName' in body) {
    const name = typeof body.fullName === 'string' ? body.fullName.trim() : '';
    if (name === '') return c.json(selfValidationError('fullName must be a non-empty text value.'), 400);
    updateData.fullName = name;
  }

  if ('email' in body) {
    if (body.email === null) {
      updateData.email = null;
    } else if (typeof body.email === 'string' && EMAIL_PATTERN.test(body.email.trim())) {
      updateData.email = body.email.trim();
    } else {
      return c.json(selfValidationError('email must be a valid address, like name@domain.cl, or null to clear it.'), 400);
    }
  }

  if ('birthDate' in body) {
    if (body.birthDate === null) {
      updateData.birthDate = null;
    } else if (typeof body.birthDate === 'string' && isPastCalendarDate(body.birthDate)) {
      updateData.birthDate = body.birthDate;
    } else {
      return c.json(selfValidationError('birthDate must be a past date as YYYY-MM-DD, or null to clear it.'), 400);
    }
  }

  const db = createDb(c.env.DATABASE_URL);

  let updated: typeof customers.$inferSelect | undefined;
  try {
    [updated] = await db
      .update(customers)
      .set({ ...updateData, updatedAt: new Date() })
      .where(
        and(
          eq(customers.globalId, userId),
          eq(customers.businessId, businessId),
          isNull(customers.deletedAt),
        ),
      )
      .returning();
  } catch (err) {
    const conflict = classifyUniqueViolation(
      err,
      { uq_customers_business_email: SELF_EMAIL_TAKEN },
      GENERIC_CONFLICT,
    );
    if (conflict) {
      return c.json({ error: { code: conflict.code, message: conflict.message } }, 409);
    }
    throw err;
  }

  if (!updated) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Customer not found' } }, 404);
  }

  // The save already happened; a queue hiccup must not turn it into an error.
  try {
    await publish(
      c.env.DOMAIN_EVENTS_QUEUE,
      createEnvelope(
        CUSTOMER_PROFILE_UPDATED,
        { business_id: businessId, timestamp: new Date().toISOString(), request_id: getRequestId(c) },
        { customer_id: updated.globalId, changed_fields: Object.keys(updateData).sort() },
      ),
    );
  } catch (err) {
    console.error('[customer] Failed to publish customer.profile_updated:', err);
  }

  return c.json(
    {
      data: {
        fullName: updated.fullName,
        email: updated.email ?? null,
        birthDate: updated.birthDate ?? null,
      },
    },
    200,
  );
});

// ---------------------------------------------------------------------------
// Self delete: DELETE /v1/customers/me
// MUST be registered BEFORE /:id, like GET and PATCH /me.
// ---------------------------------------------------------------------------

router.delete('/v1/customers/me', async (c) => {
  // The customer is the token's subject in the token's business, as in PATCH.
  const userId = c.req.header('X-User-Id');
  const businessId = c.req.header('X-Business-Id');
  if (!userId || !businessId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing identity headers' } }, 401);
  }

  return deleteCustomerAccount(c, businessId, eq(customers.globalId, userId));
});

// ---------------------------------------------------------------------------
// Lookup by globalId: GET /v1/customers/by-global-id/:globalId
// Used by POS to resolve QR scan data. Must be registered BEFORE :id.
// ---------------------------------------------------------------------------

router.get('/v1/customers/by-global-id/:globalId', async (c) => {
  const auth = extractAuthHeaders(c);
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
  const globalId = c.req.param('globalId');
  const db = createDb(c.env.DATABASE_URL);

  const [customer] = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.globalId, globalId),
        eq(customers.businessId, businessId),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);

  if (!customer) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Cliente no encontrado' } }, 404);
  }

  // Fetch current balance
  const [balanceRow] = await db
    .select({ balance_after: pointsTransactions.balanceAfter })
    .from(pointsTransactions)
    .where(eq(pointsTransactions.customerId, customer.id))
    .orderBy(desc(pointsTransactions.createdAt))
    .limit(1);

  // Resolve tier
  let tier: { id: string; name: string; multiplier: number } | null = null;
  if (customer.currentTierId) {
    const [tierRow] = await db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.id, customer.currentTierId))
      .limit(1);

    if (tierRow) {
      tier = {
        id: tierRow.id,
        name: tierRow.name,
        multiplier: Number(tierRow.multiplier),
      };
    }
  }

  return c.json({
    data: {
      id: customer.id,
      globalId: customer.globalId,
      fullName: customer.fullName,
      phone: customer.phone,
      points: balanceRow?.balance_after ?? 0,
      currentTier: tier?.name ?? null,
      tier,
    },
  });
});

// ---------------------------------------------------------------------------
// POS lookup: GET /v1/customers/lookup
// ---------------------------------------------------------------------------

/** The three ways a cashier can name the person in front of them. */
const LOOKUP_IDENTIFIERS = ['phone', 'email', 'globalId'] as const;
type LookupIdentifier = (typeof LOOKUP_IDENTIFIERS)[number];

/**
 * Ambiguity code per identifier.
 *
 * Keyed by identifier rather than a single code because the cashier's next
 * action differs: a duplicated phone is a data problem to escalate, while a
 * duplicated email is usually the same person entered twice with different
 * capitalisation. Telling them which one is broken saves a support call.
 *
 * Only the *kind* of identifier appears in the response. Never the value: this
 * body is the one place where the answer "two people share this" would
 * otherwise be the easiest place to leak the identifier itself.
 */
const LOOKUP_AMBIGUOUS_CODE: Record<LookupIdentifier, string> = {
  phone: 'CUSTOMER_PHONE_AMBIGUOUS',
  email: 'CUSTOMER_EMAIL_AMBIGUOUS',
  globalId: 'CUSTOMER_GLOBAL_ID_AMBIGUOUS',
};

const LOOKUP_AMBIGUOUS_MESSAGE: Record<LookupIdentifier, string> = {
  phone:
    'More than one customer is registered with this phone number in this business. This is a data ' +
    'problem, not something you can resolve at the counter — escalate it rather than charging one of them.',
  email:
    'More than one customer matches this email address in this business. This is a data problem, ' +
    'not something you can resolve at the counter — escalate it rather than charging one of them.',
  globalId:
    'More than one customer shares this pass identifier in this business. This is a data problem, ' +
    'not something you can resolve at the counter — escalate it rather than charging one of them.',
};

/**
 * GET /v1/customers/lookup?phone=|email=|globalId=
 *
 * Resolve **one** customer for the person at the counter, with the pass state,
 * the balance and the tier.
 *
 * Must be registered before `/v1/customers/:id`, or this path would be read as
 * a customer whose id is the literal string `lookup`.
 *
 * ## Why there is no `q` parameter
 *
 * A free-text search box is the obvious design and the wrong one here. `q` plus
 * `LIKE` is how "find the customer at the counter" quietly becomes "list the
 * customers", and a list is a different product surface with different privacy
 * consequences — one where every member of staff can enumerate the tenant's
 * entire customer base, and where a mistyped digit returns someone's balance.
 *
 * So the caller names *which* identifier it has, and each one is matched by
 * equality against a single column. `LIKE` appears nowhere in this route, which
 * also means a `%` or `_` a cashier types is matched literally instead of
 * becoming a wildcard that returns other people. The cost is that email matching
 * is case-sensitive; that is the shape of `uq_customers_business_email`, and
 * making it case-insensitive properly needs a functional index on `lower(email)`
 * rather than an `ILIKE` with a wildcard hole in it.
 *
 * ## Why `.limit(2)`
 *
 * A lookup that cannot express "more than one" would have to pick. `.limit(1)`
 * resolves a conflict by database row order, silently, and the cashier would
 * charge whichever person happened to sort first. Reading two is the only way to
 * *know* there is a conflict, and it still bounds the read.
 *
 * `uq_customers_business_phone` and `uq_customers_business_email` mean a
 * duplicated phone or email should be impossible, which is exactly why this
 * guard must not be the only thing standing between a broken constraint and a
 * wrong customer at the counter: an older database without the constraint, or a
 * constraint dropped by a migration, would otherwise be indistinguishable from a
 * normal hit.
 *
 * ## Tenant isolation
 *
 * There is no row-level security on these tables — `enableRls()` and
 * `createRlsPolicies()` in `packages/db/src/rls.ts` are never applied by any
 * migration, and this worker opens no tenant session — so the `business_id`
 * filter below is the *only* thing keeping one business from reading another's
 * customers. It comes from the token the gateway injected and from nowhere else:
 * a `businessId` in the query string is ignored, not honoured.
 *
 * ## The pass state is passed through verbatim
 *
 * `not_issued` and `not_saved` mean opposite things and this route does not
 * flatten them. `not_issued` is a gap in *our* knowledge: a save link went out
 * and no Google object was ever observed. `not_saved` is a definite answer from
 * Google: we asked, and there is no object, so the customer has not saved the
 * pass. `workers/wallet/src/callbacks.ts` calls `not_saved` "the most definite
 * answer this system can ever receive".
 *
 * A `null` state is a third fact again — no pass row at all, meaning no save
 * link was ever issued — so it is reported as `null` rather than as a state
 * string. Collapsing any of the three is what would let a merchant be told a
 * customer has no card when we simply never checked.
 */
router.get('/v1/customers/lookup', async (c) => {
  const auth = extractAuthHeaders(c);
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }

  // The tenant is the token's tenant. Never a query parameter, never a body.
  const businessId = auth.businessId;

  const provided = LOOKUP_IDENTIFIERS.filter((key) => {
    const value = c.req.query(key);
    return typeof value === 'string' && value.trim() !== '';
  });

  // Exactly one. Zero means the caller has nothing to search by; two means it
  // is confused about who it is asking for, and guessing which one it meant is
  // how a lookup starts returning the wrong person.
  if (provided.length !== 1) {
    return c.json(
      {
        error: {
          code: 'LOOKUP_IDENTIFIER_REQUIRED',
          message:
            'Provide exactly one of phone, email or globalId to look up a single customer. This ' +
            'endpoint resolves one person, not a list.',
        },
      },
      400,
    );
  }

  const identifier = provided[0]!;
  const value = c.req.query(identifier)!.trim();

  // Equality on one column, always. `eq` and never `ilike`: an `ILIKE` would let
  // a `%` in the query string widen this into a search across the tenant.
  const match =
    identifier === 'phone'
      ? eq(customers.phone, value)
      : identifier === 'email'
        ? eq(customers.email, value)
        : eq(customers.globalId, value);

  const db = createDb(c.env.DATABASE_URL);

  // `.limit(2)` — see the note above. Two is enough to detect a conflict and
  // still bounds what a single request can pull.
  const matches = await db
    .select({
      id: customers.id,
      globalId: customers.globalId,
      fullName: customers.fullName,
      phone: customers.phone,
      email: customers.email,
      currentTierId: customers.currentTierId,
    })
    .from(customers)
    .where(and(match, eq(customers.businessId, businessId), isNull(customers.deletedAt)))
    .limit(2);

  if (matches.length === 0) {
    // A distinct code from a bad request and from a 5xx, because the UI's next
    // action differs: this one can offer to register the person standing there.
    return c.json(
      {
        error: {
          code: 'CUSTOMER_NOT_REGISTERED',
          message:
            'No customer is registered under that identifier in this business. You can register them now.',
        },
      },
      404,
    );
  }

  if (matches.length > 1) {
    // Said out loud, never resolved by picking. No identity of either candidate
    // appears here: the cashier cannot act on this, and handing them one of the
    // two to act on is the failure this branch exists to prevent.
    return c.json(
      {
        error: {
          code: LOOKUP_AMBIGUOUS_CODE[identifier],
          message: LOOKUP_AMBIGUOUS_MESSAGE[identifier],
        },
      },
      409,
    );
  }

  const customer = matches[0]!;

  // Pass state, scoped to the same tenant as the customer read above. A pass row
  // is keyed by customer_id alone, so without `tenant_id` a stale or wrong id
  // would be indistinguishable from this customer's own row.
  const [pass] = await db
    .select({
      state: customerWalletPasses.state,
      lastSyncedAt: customerWalletPasses.lastSyncedAt,
    })
    .from(customerWalletPasses)
    .where(
      and(
        eq(customerWalletPasses.customerId, customer.id),
        eq(customerWalletPasses.tenantId, businessId),
      ),
    )
    .limit(1);

  // Balance: the most recent transaction's `balance_after`, never a sum of the
  // deltas. `business_id` is redundant given the customer id is a primary key,
  // and is here anyway so a wrong customer id cannot read another tenant's ledger.
  const [balanceRow] = await db
    .select({ balanceAfter: pointsTransactions.balanceAfter })
    .from(pointsTransactions)
    .where(
      and(
        eq(pointsTransactions.customerId, customer.id),
        eq(pointsTransactions.businessId, businessId),
      ),
    )
    .orderBy(desc(pointsTransactions.createdAt))
    .limit(1);

  let tier: { id: string; name: string; multiplier: number } | null = null;
  if (customer.currentTierId) {
    const [tierRow] = await db
      .select({
        id: membershipTiers.id,
        name: membershipTiers.name,
        multiplier: membershipTiers.multiplier,
      })
      .from(membershipTiers)
      .where(
        and(
          eq(membershipTiers.id, customer.currentTierId),
          eq(membershipTiers.businessId, businessId),
        ),
      )
      .limit(1);

    // Tiers are tenant-scoped rows, so a tier id pointing at another business is
    // a data problem — reported as "no tier" rather than as their tier name.
    if (tierRow) {
      tier = {
        id: tierRow.id,
        name: tierRow.name,
        multiplier: Number(tierRow.multiplier),
      };
    }
  }

  return c.json({
    data: {
      id: customer.id,
      globalId: customer.globalId,
      fullName: customer.fullName,
      phone: customer.phone,
      email: customer.email,
      points: balanceRow?.balanceAfter ?? 0,
      currentTier: tier?.name ?? null,
      tier,
      // Verbatim state plus the moment we last had a definite answer from Google.
      // The counter needs to be able to say "we checked on Tuesday", which is
      // what separates a real answer from a month-old cached one.
      pass: {
        state: pass?.state ?? null,
        lastSyncedAt: pass?.lastSyncedAt ? pass.lastSyncedAt.toISOString() : null,
      },
      // No `memberCode`: it is the pass `accountId` and an identity value with
      // no use at a counter, so it stays out of this payload on purpose.
    },
  });
});

// ---------------------------------------------------------------------------
// Profile: GET /v1/customers/:id
// ---------------------------------------------------------------------------

router.get('/v1/customers/:id', async (c) => {
  const auth = extractAuthHeaders(c);
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
  const id = c.req.param('id');
  const db = createDb(c.env.DATABASE_URL);

  // Run customer query + events + consents + points in parallel
  const [customerResult, eventsResult, consentsResult, balanceResult, earnedResult, txResult] =
    await Promise.all([
    db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.id, id),
          eq(customers.businessId, businessId),
          isNull(customers.deletedAt),
        ),
      )
      .limit(1),
    // Last 20 events, newest first
    db
      .select()
      .from(customerEvents)
        .where(and(eq(customerEvents.customerId, id), eq(customerEvents.businessId, businessId)))
      .orderBy(desc(customerEvents.createdAt))
      .limit(20),
    db
      .select()
      .from(consents)
        .where(and(eq(consents.customerId, id), eq(consents.businessId, businessId))),
    // Latest balance
    db
      .select({ balance_after: pointsTransactions.balanceAfter })
      .from(pointsTransactions)
      .where(eq(pointsTransactions.customerId, id))
      .orderBy(desc(pointsTransactions.createdAt))
      .limit(1),
    // Total points earned
    db
      .select({ total: sum(pointsTransactions.points) })
      .from(pointsTransactions)
      .where(
        and(
          eq(pointsTransactions.customerId, id),
          or(eq(pointsTransactions.type, 'earn'), eq(pointsTransactions.type, 'earned')),
        ),
      ),
    // Last 5 transactions for activity timeline
    db
      .select({
        id: pointsTransactions.id,
        type: pointsTransactions.type,
        points: pointsTransactions.points,
        balanceAfter: pointsTransactions.balanceAfter,
        note: pointsTransactions.note,
        purchaseAmount: pointsTransactions.purchaseAmount,
        createdAt: pointsTransactions.createdAt,
      })
      .from(pointsTransactions)
      .where(eq(pointsTransactions.customerId, id))
      .orderBy(desc(pointsTransactions.createdAt))
      .limit(5),
  ]);

  if (customerResult.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Customer not found' } }, 404);
  }

  const points = balanceResult[0]?.balance_after ?? 0;
  const totalPointsEarned = Number(earnedResult[0]?.total ?? 0);

  return c.json({
    ...customerResult[0],
    points,
    totalPointsEarned,
    customer_events: eventsResult,
    recent_transactions: txResult,
    consents: consentsResult,
  });
});

// ---------------------------------------------------------------------------
// Partial update: PATCH /v1/customers/:id
// ---------------------------------------------------------------------------

/**
 * `23505`, as `@neondatabase/serverless` surfaces a failed unique index.
 *
 * `constraint_name` is the field that makes this translatable: `phone` and
 * `email` are different mistakes for the operator and get different sentences,
 * while an index this route has no message for still gets a conflict rather than
 * a 500.
 */
const PG_UNIQUE_VIOLATION = '23505';

const UNIQUE_CONSTRAINT_MESSAGES: Record<string, { code: string; message: string }> = {
  uq_customers_business_phone: {
    code: CUSTOMER_PATCH_ERROR.PHONE_TAKEN,
    message:
      'Another customer in this business already uses this phone number. Search for that phone to find them, ' +
      'or correct the number here — the customer stays on their own record.',
  },
  uq_customers_business_email: {
    code: CUSTOMER_PATCH_ERROR.EMAIL_TAKEN,
    message:
      'Another customer in this business already uses this email address. Search for that address to find them, ' +
      'or correct it here — the customer stays on their own record.',
  },
};

/** A unique index we have no dedicated sentence for is still a conflict. */
const GENERIC_CONFLICT = {
  code: CUSTOMER_PATCH_ERROR.CONFLICT,
  message:
    'This change collides with another record in this business, so nothing was saved. Nothing here can be ' +
    'resolved at the counter — check the value you entered and escalate it if it looks right.',
};

/**
 * The same condition, said to the person registering rather than to the operator.
 *
 * The code is deliberately `EMAIL_TAKEN` and not a registration-specific one: the
 * condition is identical — another customer of this business already holds that
 * address — and a client that already knows that code keeps working. Only the
 * remedy differs, and the remedy is what the sentence carries.
 *
 * Two constraints shaped the wording:
 *
 *  - `apps/customer-web/app/register/page.tsx` surfaces the server's own message
 *    when it is at most 180 characters, so this has to stay under that or the
 *    customer falls back to "no pudimos completar el registro" and learns nothing.
 *  - The field is optional on that form. The useful instruction is therefore the
 *    one that lets them finish: leave it blank.
 */
const REGISTRATION_UNIQUE_MESSAGES: Record<string, { code: string; message: string }> = {
  uq_customers_business_email: {
    code: CUSTOMER_PATCH_ERROR.EMAIL_TAKEN,
    message:
      'Ese correo ya está en uso en este local. Podés dejarlo vacío — es opcional — y registrarte igual.',
  },
};

const REGISTRATION_GENERIC_CONFLICT = {
  code: CUSTOMER_PATCH_ERROR.CONFLICT,
  message: 'No pudimos registrarte con estos datos. Revisá los campos e intentá de nuevo.',
};

/**
 * Read a unique-index violation out of a driver error, or return `null`.
 *
 * Shared by registration and the dashboard's edit route because both write to
 * `customers` under the same two indexes, and they have disagreed exactly once
 * already: `PATCH` learned to translate `23505` and `PUT` did not, so a duplicate
 * email on registration surfaced as `500 INTERNAL_ERROR` for a condition the
 * operator could have been told about in one sentence.
 *
 * `null` means "not a unique violation", and the caller rethrows. Reporting a
 * dropped connection as a conflict is worse than a 500: it sends whoever reads it
 * hunting for a collision that does not exist.
 */
function classifyUniqueViolation(
  err: unknown,
  messages: Record<string, { code: string; message: string }>,
  generic: { code: string; message: string },
): { code: string; message: string } | null {
  // `@neondatabase/serverless` reports the driver error on `cause` when the driver
  // has already unwrapped it, so both shapes are read rather than one.
  const failure = err as {
    code?: unknown;
    constraint_name?: unknown;
    constraint?: unknown;
    cause?: { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  };

  const code = failure?.code ?? failure?.cause?.code;
  if (code !== PG_UNIQUE_VIOLATION) return null;

  // The field is `constraint`, not `constraint_name`.
  //
  // A Postgres driver error carries several fields whose names differ per driver,
  // and the one this route has been reading since PR #177 does not exist on this
  // one: the key set on `cause` is `name, severity, code, detail, hint, position,
  // internalPosition, internalQuery, where, schema, table, column, dataType,
  // constraint, file, line, routine, sourceError`. Reading `constraint_name` alone
  // yields `undefined`, so the lookup misses and every violation silently fell
  // through to the generic conflict.
  //
  // That failure is invisible from the outside: the status was already a correct
  // 409, the sentence was merely the vaguer one, and a vague but plausible answer
  // is what a wrong lookup looks like. Both names are read so a driver that does
  // use `constraint_name` keeps working.
  const constraint = failure?.constraint ?? failure?.cause?.constraint;
  const legacyConstraint = failure?.constraint_name ?? failure?.cause?.constraint_name;

  const named = [constraint, legacyConstraint].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );

  return (named ? messages[named] : undefined) ?? generic;
}

router.patch('/v1/customers/:id', async (c) => {
  const auth = extractAuthHeaders(c);
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
  const id = c.req.param('id');
  const db = createDb(c.env.DATABASE_URL);

  // Verify customer exists and belongs to this business.
  //
  // First, before the body is even looked at, and the filter takes the tenant
  // from the token — never from the payload. That stays the answer for another
  // business's customer whatever they send.
  const existing = await db
    .select()
    .from(customers)
    .where(
      and(eq(customers.id, id), eq(customers.businessId, businessId), isNull(customers.deletedAt)),
    )
    .limit(1);

  if (existing.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Customer not found' } }, 404);
  }

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON' } },
      400,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a JSON object of fields to change',
        },
      },
      400,
    );
  }

  const body = parsed as Record<string, unknown>;
  const editable = new Set<string>(CUSTOMER_PATCHABLE_FIELDS);

  // The allowlist, and it refuses rather than filters.
  //
  // This used to be `const { businessId, ...updateData } = body` with everything
  // else spread into `.set()`, which made "the columns a merchant can write" a
  // property of the request rather than of the endpoint. `globalId` was the
  // expensive one: `object_id` is `<issuerId>.member-<globalId>`, so rewriting it
  // re-points the pass we issue at a different Google object, the object already
  // on the customer's phone stops being theirs, and the old one is not deleted.
  //
  // Naming the offending field rather than dropping it is the other half. A
  // silently ignored `globalId` leaves the operator certain it changed, and
  // "it said 200 and nothing happened" is the failure nobody reports.
  const rejected = Object.keys(body).filter((field) => !editable.has(field));
  if (rejected.length > 0) {
    return c.json(
      {
        error: {
          code: CUSTOMER_PATCH_ERROR.NOT_PATCHABLE,
          message:
            `This endpoint cannot change: ${rejected.join(', ')}. ` +
            `The editable fields are ${CUSTOMER_PATCHABLE_FIELDS.join(', ')} — nothing was saved, ` +
            `so correct the request and send it again.`,
        },
      },
      400,
    );
  }

  const provided = Object.keys(body);
  if (provided.length === 0) {
    return c.json(
      {
        error: {
          code: CUSTOMER_PATCH_ERROR.EMPTY,
          message:
            `The request named no field to change. Send at least one of ` +
            `${CUSTOMER_PATCHABLE_FIELDS.join(', ')}.`,
        },
      },
      400,
    );
  }

  // Build the SET clause by hand rather than spreading.
  //
  // The spread version could produce a key whose value was `undefined`, which
  // drizzle hands to Postgres as NULL: editing a phone would have emptied the
  // email. `undefined` therefore never reaches the UPDATE — absent means
  // untouched — and clearing a nullable column has to be spelled as `null`.
  const updateData: Record<string, string | null> = {};
  for (const field of CUSTOMER_PATCHABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const value = body[field];
    if (value === null) {
      updateData[field] = null;
      continue;
    }
    if (typeof value !== 'string') {
      return c.json(
        {
          error: {
            code: CUSTOMER_PATCH_ERROR.INVALID_VALUE,
            message: `${field} must be a text value or null to clear it, and nothing was saved.`,
          },
        },
        400,
      );
    }
    updateData[field] = value;
  }

  // Same normalisation as PUT /v1/customers. Both the unique index and the POS
  // equality lookup read the stored value, so an unstripped phone saved here is
  // a number the counter can never match against.
  if (typeof updateData.phone === 'string') {
    updateData.phone = updateData.phone.replace(/\s+/g, '');
  }

  try {
    const [updated] = await db
      .update(customers)
      .set({ ...updateData, updatedAt: new Date() })
      .where(
        and(
          eq(customers.id, id),
          eq(customers.businessId, businessId),
          isNull(customers.deletedAt),
        ),
      )
      .returning();

    return c.json(updated, 200);
  } catch (err) {
    const conflict = classifyUniqueViolation(err, UNIQUE_CONSTRAINT_MESSAGES, GENERIC_CONFLICT);

    if (conflict) {
      // 409, not 400: the request was well-formed, the business's own data is
      // what conflicts with it.
      return c.json({ error: { code: conflict.code, message: conflict.message } }, 409);
    }

    // Anything else is genuinely ours. Reporting a broken connection as "that
    // phone belongs to someone else" would send the operator hunting for a
    // conflict that does not exist.
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Delete: DELETE /v1/customers/:id
// Anonymises, the same way as DELETE /v1/customers/me.
// ---------------------------------------------------------------------------

router.delete('/v1/customers/:id', async (c) => {
  const auth = extractAuthHeaders(c);
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }

  return deleteCustomerAccount(c, auth.businessId, eq(customers.id, c.req.param('id')));
});

export default router;
