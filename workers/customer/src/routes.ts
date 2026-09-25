import { createDb, customers, customerEvents, consents, tenants, loyaltyPrograms, pointsTransactions, membershipTiers } from '@vyloop/db';
import { CUSTOMER_REGISTERED, PROFILE_VIEWED, createEnvelope, publish } from '@vyloop/event-bus';
import { validate } from '@vyloop/schema-registry';
import { eq, and, isNull, like, or, count, desc, asc, sum, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
// import { HTTPException } from 'hono/http-exception';

import type { Bindings } from './helpers';
import { extractAuthHeaders, buildCustomerRegisteredEvent } from './helpers';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = new Hono<{ Bindings: Bindings }>();

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
  }>();

  if (!body.fullName || !body.phone) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'fullName and phone are required' } },
      400,
    );
  }

  // Normalize phone: strip whitespace so '+569 5678 9012' is stored as '+56956789012'
  body.phone = body.phone.replace(/\s+/g, '');

  const db = createDb(c.env.DATABASE_URL);

  // Resolve businessId: from auth headers (JWT flow) or businessSlug (public registration)
  let businessId: string;
  try {
    const auth = extractAuthHeaders(c);
    businessId = auth.businessId;
  } catch {
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

    const [updated] = await db
      .update(customers)
      .set(updateData)
      .where(eq(customers.id, customer.id))
      .returning();

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

  const [inserted] = await db
    .insert(customers)
    .values(insertData)
    .returning();

  // Validate event payload against schema registry
  const event = buildCustomerRegisteredEvent(inserted, businessId);
  const schemaResult = await validate(
    c.env.SCHEMA_REGISTRY,
    CUSTOMER_REGISTERED,
    event.payload,
  );

  if (!schemaResult.valid) {
    console.error(
      '[customer] Event payload validation failed:',
      schemaResult.errors,
    );
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Event payload validation failed',
          details: schemaResult.errors,
        },
      },
      500,
    );
  }

  // Publish event to domain events queue
  await publish(c.env.DOMAIN_EVENTS_QUEUE, event);

  return c.json({ ...inserted, event_published: true }, 201);
});

// ---------------------------------------------------------------------------
// List: GET /v1/customers
// ---------------------------------------------------------------------------

router.get('/v1/customers', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const q = c.req.query('q') || '';
  const offset = (page - 1) * limit;

  const db = createDb(c.env.DATABASE_URL);

  // Base conditions: RLS scope + active customers only
  const conditions: SQL[] = [
    eq(customers.businessId, businessId),
    isNull(customers.deletedAt),
  ];

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
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Missing X-User-Id header' } },
      401,
    );
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
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Customer not found' } },
      404,
    );
  }

  // Fetch balance, total earned, events, recent transactions, last-30-days
  // points, and the loyalty "pass" context (business, program, tiers).
  const [balanceResult, earnedResult, eventsResult, txResult, points30Result, businessResult, programResult, tiersResult] = await Promise.all([
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
          createEnvelope(PROFILE_VIEWED, {
            business_id: businessId,
            timestamp: new Date().toISOString(),
          }, {
            customer_id: customer.globalId,
          }),
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
      customer_events: eventsResult,
      recent_transactions: txResult,
      createdAt: customer.createdAt,
    },
  });
});

// ---------------------------------------------------------------------------
// Lookup by globalId: GET /v1/customers/by-global-id/:globalId
// Used by POS to resolve QR scan data. Must be registered BEFORE :id.
// ---------------------------------------------------------------------------

router.get('/v1/customers/by-global-id/:globalId', async (c) => {
  const { businessId } = extractAuthHeaders(c);
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
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Cliente no encontrado' } },
      404,
    );
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
// Profile: GET /v1/customers/:id
// ---------------------------------------------------------------------------

router.get('/v1/customers/:id', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const id = c.req.param('id');
  const db = createDb(c.env.DATABASE_URL);

  // Run customer query + events + consents + points in parallel
  const [customerResult, eventsResult, consentsResult, balanceResult, earnedResult, txResult] = await Promise.all([
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
      .where(
        and(
          eq(customerEvents.customerId, id),
          eq(customerEvents.businessId, businessId),
        ),
      )
      .orderBy(desc(customerEvents.createdAt))
      .limit(20),
    db
      .select()
      .from(consents)
      .where(
        and(
          eq(consents.customerId, id),
          eq(consents.businessId, businessId),
        ),
      ),
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
        createdAt: pointsTransactions.createdAt,
      })
      .from(pointsTransactions)
      .where(eq(pointsTransactions.customerId, id))
      .orderBy(desc(pointsTransactions.createdAt))
      .limit(5),
  ]);

  if (customerResult.length === 0) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Customer not found' } },
      404,
    );
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

router.patch('/v1/customers/:id', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();

  // Silently ignore business_id / businessId from body (defense)
  const { businessId: _ignoreBiz, business_id: _ignoreBizSnake, ...updateData } = body;

  const db = createDb(c.env.DATABASE_URL);

  // Verify customer exists and belongs to this business
  const existing = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.id, id),
        eq(customers.businessId, businessId),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Customer not found' } },
      404,
    );
  }

  // Apply partial update with only provided fields
  const [updated] = await db
    .update(customers)
    .set({ ...updateData, updatedAt: new Date() })
    .where(eq(customers.id, id))
    .returning();

  return c.json(updated, 200);
});

// ---------------------------------------------------------------------------
// Soft delete: DELETE /v1/customers/:id
// ---------------------------------------------------------------------------

router.delete('/v1/customers/:id', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const id = c.req.param('id');
  const db = createDb(c.env.DATABASE_URL);

  // Verify customer exists and belongs to this business
  const existing = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.id, id),
        eq(customers.businessId, businessId),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Customer not found' } },
      404,
    );
  }

  // Soft delete: set deleted_at
  await db
    .update(customers)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(customers.id, id));

  return c.body(null, 204);
});

export default router;
