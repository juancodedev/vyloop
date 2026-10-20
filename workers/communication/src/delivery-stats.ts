import { createDb, messageLog } from '@vyloop/db';
import { requireOperatorRole } from '@vyloop/types';
import { and, count, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { Bindings } from './helpers';
import { extractAuthHeaders, withRls } from './helpers';

// ---------------------------------------------------------------------------
// The push delivery dashboard.
//
// A delivery that cannot be seen is a delivery that did not happen. This route
// is how an operator sees the push deliveries of their business: how many are
// queued, how many were sent, how many failed, and which ones those are.
//
// ## The operator guard
//
// The same shared guard every operator route in this repository uses. A
// customer's own message history is theirs; the delivery dashboard is the
// business's, and it is about the business's push infrastructure rather than
// about any one customer's messages.
//
// ## The channel is the push channel
//
// Everything here is read from `message_log` where the channel is `push`. The
// WhatsApp deliveries live in the same table and are counted by the history
// route, not by this one.
//
// ## The pagination is the history route's pagination
//
// `page`, `per_page`, at most a hundred at a time, and a `meta` that says how
// many there are in total. A dashboard that paginates differently from the
// history it sits next to is a dashboard nobody can reason about.
// ---------------------------------------------------------------------------

const router = new Hono<{ Bindings: Bindings }>();

/**
 * The message a refused operator route answers with.
 *
 * A parameter of the shared guard rather than a fact of it: the decision is
 * shared, and the prose about it is about this route.
 */
const OPERATOR_ROLE_REQUIRED_MESSAGE =
  'Only a merchant can read the push delivery dashboard. A customer sees their own messages.';

/** The status of a delivery that is still waiting to go out. */
const STATUS_QUEUED = 'queued';
/** The status of a delivery the push service accepted. */
const STATUS_SENT = 'sent';
/** The status of a delivery that failed for good. */
const STATUS_FAILED = 'failed';

/**
 * The counts, by status.
 *
 * The three the dashboard shows. A status nobody asked about is not a count
 * nobody needs.
 */
interface DeliveryCounts {
  queued: number;
  sent: number;
  failed: number;
}

/**
 * GET /v1/communication/push/deliveries
 *
 * The push deliveries of this business: the counts by status, and the most
 * recent ones.
 */
router.get('/v1/communication/push/deliveries', async (c) => {
  const auth = extractAuthHeaders(c);

  // Before the database, before anything is read: the guard reads nothing and
  // writes nothing, so an unauthorized caller cannot make the route do work on
  // their behalf.
  const gate = requireOperatorRole(auth, OPERATOR_ROLE_REQUIRED_MESSAGE);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }

  const { businessId } = auth;

  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(c.req.query('per_page') ?? '20', 10) || 20));

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  // The push deliveries of this business, and nothing else.
  const where = and(eq(messageLog.businessId, businessId), eq(messageLog.channel, 'push'));

  // -------------------------------------------------------------------------
  // The counts, by status
  // -------------------------------------------------------------------------
  const byStatus = await db
    .select({ status: messageLog.status, total: count() })
    .from(messageLog)
    .where(where)
    .groupBy(messageLog.status);

  const counts: DeliveryCounts = { queued: 0, sent: 0, failed: 0 };
  for (const row of byStatus as { status: string; total: number | string }[]) {
    if (row.status === STATUS_QUEUED) counts.queued = Number(row.total ?? 0);
    if (row.status === STATUS_SENT) counts.sent = Number(row.total ?? 0);
    if (row.status === STATUS_FAILED) counts.failed = Number(row.total ?? 0);
  }

  // -------------------------------------------------------------------------
  // The deliveries
  // -------------------------------------------------------------------------
  const [totalResult] = await db.select({ total: count() }).from(messageLog).where(where);

  const total = Number(totalResult?.total ?? 0);

  const items = await db
    .select()
    .from(messageLog)
    .where(where)
    .orderBy(desc(messageLog.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return c.json({
    counts,
    data: items,
    meta: { total, page, per_page: perPage },
  });
});

export default router;
