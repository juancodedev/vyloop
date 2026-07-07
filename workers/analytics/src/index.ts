import { createDb, setCurrentBusinessId } from '@vyloop/db';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TimelineItem {
  type: 'customer.created' | 'points.earned' | 'points.redeemed' | 'customer.event';
  customerName: string;
  description: string;
  timestamp: string;
}

interface KpiResponse {
  totalCustomers: number;
  activeCustomers: number;
  totalPointsIssued: number;
  totalPointsRedeemed: number;
  redemptionRate: number;
  tierDistribution: Record<string, number>;
  rewardsClaimed: number;
}

interface AuthHeaders {
  userId: string;
  businessId: string;
  userRole: string;
}

type Bindings = {
  DATABASE_URL: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractAuthHeaders(c: {
  req: { header: (name: string) => string | undefined };
}): AuthHeaders {
  const userId = c.req.header('X-User-Id');
  const businessId = c.req.header('X-Business-Id');
  const userRole = c.req.header('X-User-Role');

  if (!userId || !businessId || !userRole) {
    throw new HTTPException(403, { message: 'Missing authentication headers' });
  }

  return { userId, businessId, userRole };
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Bindings }>();

// ---------------------------------------------------------------------------
// GET /v1/analytics/kpis
// ---------------------------------------------------------------------------

app.get('/v1/analytics/kpis', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const db = createDb(c.env.DATABASE_URL);
  await db.execute(setCurrentBusinessId(businessId));

  const customerResult = await db.execute(sql`
    SELECT
      count(*) AS total_customers,
      count(*) FILTER (WHERE deleted_at IS NULL) AS active_customers
    FROM customers
    WHERE business_id = ${businessId}::uuid
  `);
  const pointsResult = await db.execute(sql`
    SELECT
      COALESCE(sum(points) FILTER (WHERE type = 'earn'), 0) AS total_issued,
      COALESCE(sum(points) FILTER (WHERE type = 'redeem'), 0) AS total_redeemed
    FROM points_transactions
    WHERE business_id = ${businessId}::uuid
  `);
  const tierResult = await db.execute(sql`
    SELECT mt.name, count(c.id) AS customer_count
    FROM membership_tiers mt
    LEFT JOIN customers c ON c.current_tier_id = mt.id AND c.business_id = ${businessId}::uuid
    WHERE mt.business_id = ${businessId}::uuid
    GROUP BY mt.id, mt.name, mt.display_order
    ORDER BY mt.display_order
  `);
  const rewardResult = await db.execute(sql`
    SELECT count(*) AS rewards_claimed
    FROM reward_grants
    WHERE business_id = ${businessId}::uuid
  `);

  const customers = customerResult.rows?.[0] ?? {
    total_customers: 0,
    active_customers: 0,
  };
  const points = pointsResult.rows?.[0] ?? { total_issued: 0, total_redeemed: 0 };
  const tiers = tierResult.rows ?? [];
  const rewards = rewardResult.rows?.[0] ?? { rewards_claimed: 0 };

  const totalIssued = Number(points.total_issued);
  const totalRedeemed = Number(points.total_redeemed);
  const redemptionRate =
    totalIssued > 0 ? Math.round((totalRedeemed / totalIssued) * 100 * 100) / 100 : 0;

  const tierDistribution: Record<string, number> = {};
  for (const row of tiers) {
    tierDistribution[String(row.name)] = Number(row.customer_count);
  }

  return c.json({
    totalCustomers: Number(customers.total_customers),
    activeCustomers: Number(customers.active_customers),
    totalPointsIssued: totalIssued,
    totalPointsRedeemed: totalRedeemed,
    redemptionRate,
    tierDistribution,
    rewardsClaimed: Number(rewards.rewards_claimed),
  } satisfies KpiResponse);
});

// ---------------------------------------------------------------------------
// GET /v1/analytics/timeline
// ---------------------------------------------------------------------------

app.get('/v1/analytics/timeline', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const db = createDb(c.env.DATABASE_URL);
  await db.execute(setCurrentBusinessId(businessId));

  const result = await db.execute(sql`
    SELECT type, customer_name, description, timestamp
    FROM (
      -- Recent customer registrations
      SELECT
        'customer.created' AS type,
        c.full_name AS customer_name,
        'Nuevo cliente registrado' AS description,
        c.created_at AS timestamp
      FROM customers c
      WHERE c.business_id = ${businessId}::uuid
        AND c.deleted_at IS NULL

      UNION ALL

      -- Recent points transactions with customer name
      SELECT
        CASE pt.type
          WHEN 'earn'   THEN 'points.earned'
          WHEN 'redeem' THEN 'points.redeemed'
        END AS type,
        c.full_name AS customer_name,
        CASE pt.type
          WHEN 'earn'
            THEN 'Ganó ' || ABS(pt.points) || ' pts - ' || COALESCE(pt.note, '')
          WHEN 'redeem'
            THEN 'Canjeó ' || ABS(pt.points) || ' pts - ' || COALESCE(pt.note, '')
        END AS description,
        pt.created_at AS timestamp
      FROM points_transactions pt
      JOIN customers c ON c.id = pt.customer_id
      WHERE pt.business_id = ${businessId}::uuid

      UNION ALL

      -- Recent customer events
      SELECT
        'customer.event' AS type,
        c.full_name AS customer_name,
        ce.event_type AS description,
        ce.created_at AS timestamp
      FROM customer_events ce
      JOIN customers c ON c.id = ce.customer_id
      WHERE ce.business_id = ${businessId}::uuid
    ) AS timeline
    ORDER BY timestamp DESC
    LIMIT 20
  `);

  const items: TimelineItem[] = (result.rows ?? []).map((row) => ({
    type: row.type as TimelineItem['type'],
    customerName: String(row.customer_name ?? ''),
    description: String(row.description ?? ''),
    timestamp: String(row.timestamp),
  }));

  return c.json(items);
});

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.notFound((c) => {
  return c.json(
    { error: { code: 'NOT_FOUND', message: 'Route not found' } },
    404,
  );
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  console.error('[analytics] Unhandled error:', err);

  if (err instanceof HTTPException) {
    return c.json(
      { error: { code: 'ERROR', message: err.message } },
      err.status,
    );
  }

  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    500,
  );
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default { fetch: app.fetch.bind(app) };
