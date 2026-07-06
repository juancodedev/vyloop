import { createDb, customers, customerEvents, consents, tenants, pointsTransactions, membershipTiers } from '@vyloop/db';
import { CUSTOMER_REGISTERED, publish } from '@vyloop/event-bus';
import { validate } from '@vyloop/schema-registry';
import { eq, and, isNull, like, or, count, desc, sum, type SQL } from 'drizzle-orm';
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
  const [totalResult, data] = await Promise.all([
    db.select({ total: count() }).from(customers).where(where),
    db
      .select()
      .from(customers)
      .where(where)
      .limit(limit)
      .offset(offset)
      .orderBy(customers.createdAt),
  ]);

  const total = totalResult[0]?.total ?? 0;

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

  // Fetch balance, total earned, tier, and events in parallel
  const [balanceResult, earnedResult, eventsResult] = await Promise.all([
    // Latest balance (uses customer.id PK — matches FK on points_transactions)
    db
      .select({ balance_after: pointsTransactions.balanceAfter })
      .from(pointsTransactions)
      .where(eq(pointsTransactions.customerId, customer.id))
      .orderBy(desc(pointsTransactions.createdAt))
      .limit(1),
    // Total points earned (sum of all 'earn' transactions)
    db
      .select({ total: sum(pointsTransactions.points) })
      .from(pointsTransactions)
      .where(
        and(
          eq(pointsTransactions.customerId, customer.id),
          eq(pointsTransactions.type, 'earn'),
        ),
      ),
    // Last 10 customer events
    db
      .select()
      .from(customerEvents)
      .where(eq(customerEvents.customerId, customer.id))
      .orderBy(desc(customerEvents.createdAt))
      .limit(10),
  ]);

  const points = balanceResult[0]?.balance_after ?? 0;
  const totalPointsEarned = Number(earnedResult[0]?.total ?? 0);

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
      currentTierId: customer.currentTierId,
      currentTier: tier?.name ?? null,
      tier,
      customer_events: eventsResult,
      createdAt: customer.createdAt,
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

  // Run customer query + events + consents in parallel
  const [customerResult, eventsResult, consentsResult] = await Promise.all([
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
    db
      .select()
      .from(customerEvents)
      .where(
        and(
          eq(customerEvents.customerId, id),
          eq(customerEvents.businessId, businessId),
        ),
      )
      .orderBy(customerEvents.createdAt),
    db
      .select()
      .from(consents)
      .where(
        and(
          eq(consents.customerId, id),
          eq(consents.businessId, businessId),
        ),
      ),
  ]);

  if (customerResult.length === 0) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Customer not found' } },
      404,
    );
  }

  return c.json({
    ...customerResult[0],
    customer_events: eventsResult,
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
