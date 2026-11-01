import {
  createDb,
  messageLog,
  whatsappTemplates,
  customers,
  readConsentMap,
  withTenantTransaction,
} from '@vyloop/db';
import { publish } from '@vyloop/event-bus';
import { eq, and, desc, count, sql, getTableColumns } from 'drizzle-orm';
import { Hono } from 'hono';

import type { Bindings } from './helpers';
import { extractAuthHeaders, buildWhatsAppOutboundRequestedEvent } from './helpers';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = new Hono<{ Bindings: Bindings }>();

// ============================================================================
// POST /v1/communication/send
// ============================================================================

/**
 * POST /v1/communication/send
 *
 * Enqueue a WhatsApp outbound message.
 * - Validates WhatsApp consent on customer record
 * - Idempotent via reference_id
 * - Creates message_log entry with status='queued'
 * - Publishes WhatsAppOutboundRequested event
 */
router.post('/v1/communication/send', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const body = await c.req.json<{
    customer_id: string;
    template_name: string;
    parameters?: Record<string, string>;
    phone?: string;
    reference_id?: string;
  }>();

  if (!body.customer_id || !body.template_name) {
    return c.json(
      {
        error: { code: 'VALIDATION_ERROR', message: 'customer_id and template_name are required' },
      },
      400,
    );
  }

  const db = createDb(c.env.DATABASE_URL);

  // The checks and the log row run in one tenant transaction; the event is
  // published after it commits.
  const outcome = await withTenantTransaction(db, { businessId }, async (tx) => {
    // -----------------------------------------------------------------------
    // Validate customer exists and check consent
    // -----------------------------------------------------------------------
    const [customer] = await tx
      .select({ id: customers.id, phone: customers.phone })
      .from(customers)
      .where(and(eq(customers.businessId, businessId), eq(customers.id, body.customer_id)))
      .limit(1);

    if (!customer) {
      return {
        response: c.json(
          { error: { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' } },
          404,
        ),
      };
    }

    // The consent is read from the authoritative store.
    //
    // It used to be a flag in the customer's jsonb metadata, and that flag had no
    // writer: the table that was supposed to record a consent was read by two
    // surfaces and written by none. A flag cannot say when the agreement began or
    // when it was withdrawn, and a consent that cannot be withdrawn is not a
    // consent.
    const consents = await readConsentMap(tx, {
      businessId,
      customerId: body.customer_id,
    });

    if (consents.whatsapp !== true) {
      return {
        response: c.json(
          {
            error: {
              code: 'CONSENT_REQUIRED',
              message: 'Customer has not consented to WhatsApp messaging',
            },
          },
          403,
        ),
      };
    }

    // -----------------------------------------------------------------------
    // Resolve phone number
    // -----------------------------------------------------------------------
    const phone = body.phone ?? customer.phone;

    if (!phone) {
      return {
        response: c.json(
          { error: { code: 'PHONE_REQUIRED', message: 'No phone number available for this customer' } },
          400,
        ),
      };
    }

    // -----------------------------------------------------------------------
    // Idempotency check
    // -----------------------------------------------------------------------
    const referenceId =
      body.reference_id ?? `${body.customer_id}-${body.template_name}-${Date.now()}`;

    const [existing] = await tx
      .select({ id: messageLog.id })
      .from(messageLog)
      .where(
        and(
          eq(messageLog.businessId, businessId),
          eq(messageLog.customerId, body.customer_id),
          // Use content->>'reference_id' as a dedup signal
          sql`${messageLog.content}->>'reference_id' = ${referenceId}`,
        ),
      )
      .limit(1);

    if (existing) {
      return {
        response: c.json(
          {
            error: {
              code: 'DUPLICATE_MESSAGE',
              message: 'A message with this reference already exists',
            },
          },
          409,
        ),
      };
    }

    // -----------------------------------------------------------------------
    // Create message_log entry
    // -----------------------------------------------------------------------
    const [logEntry] = await tx
      .insert(messageLog)
      .values({
        businessId,
        customerId: body.customer_id,
        direction: 'outbound',
        channel: 'whatsapp',
        status: 'queued',
        content: {
          template_name: body.template_name,
          parameters: body.parameters ?? {},
          reference_id: referenceId,
        },
      })
      .returning();

    return { logEntry, phone };
  });

  if ('response' in outcome) {
    return outcome.response;
  }

  const { logEntry, phone } = outcome;

  // -----------------------------------------------------------------------
  // Publish event
  // -----------------------------------------------------------------------
  const event = buildWhatsAppOutboundRequestedEvent(
    body.customer_id,
    businessId,
    body.template_name,
    body.parameters ?? {},
    logEntry.id,
    phone,
  );

  await publish(c.env.DELIVERY_QUEUE, event);

  return c.json({ data: logEntry }, 202);
});

// ============================================================================
// GET /v1/communication/templates
// ============================================================================

/**
 * GET /v1/communication/templates
 *
 * List WhatsApp templates for the current business.
 * Supports ?category= filter and pagination.
 */
router.get('/v1/communication/templates', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const category = c.req.query('category');
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(c.req.query('per_page') ?? '20', 10) || 20));

  const db = createDb(c.env.DATABASE_URL);

  const conditions: ReturnType<typeof and>[] = [eq(whatsappTemplates.businessId, businessId)];

  if (category) {
    conditions.push(eq(whatsappTemplates.category, category));
  }

  const where = and(...conditions);

  const { total, items } = await withTenantTransaction(db, { businessId }, async (tx) => {
    const [totalResult] = await tx.select({ total: count() }).from(whatsappTemplates).where(where);

    const rows = await tx
      .select()
      .from(whatsappTemplates)
      .where(where)
      .orderBy(desc(whatsappTemplates.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage);

    return { total: Number(totalResult?.total ?? 0), items: rows };
  });

  return c.json({
    data: items,
    meta: { total, page, per_page: perPage },
  });
});

// ============================================================================
// POST /v1/communication/templates
// ============================================================================

/**
 * POST /v1/communication/templates
 *
 * Create a new WhatsApp template entry.
 */
router.post('/v1/communication/templates', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const body = await c.req.json<{
    name: string;
    language: string;
    category: string;
    body: string;
  }>();

  if (!body.name || !body.language || !body.category || !body.body) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'name, language, category, and body are required',
        },
      },
      400,
    );
  }

  const db = createDb(c.env.DATABASE_URL);

  const [inserted] = await withTenantTransaction(db, { businessId }, (tx) =>
    tx
      .insert(whatsappTemplates)
      .values({
        businessId,
        name: body.name,
        language: body.language,
        category: body.category,
        body: body.body,
      })
      .returning(),
  );

  return c.json({ data: inserted }, 201);
});

// ============================================================================
// GET /v1/communication/history
// ============================================================================

/**
 * GET /v1/communication/history
 *
 * Paginated message log for the current business.
 * Supports ?customer_id=, ?status=, ?channel= filters.
 *
 * ## The channel filter
 *
 * The channel is optional, and when it is absent every channel is returned.
 *
 * It used to be `channel = 'whatsapp'` in hardcode, which made a push delivery
 * invisible in the history of the very business it was delivered for. A
 * delivery nobody can see is a delivery that did not happen, so the filter is
 * a filter now: name a channel and only that one comes back, name none and
 * they all do.
 */
router.get('/v1/communication/history', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const customerId = c.req.query('customer_id');
  const statusFilter = c.req.query('status');
  const channelFilter = c.req.query('channel');
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(c.req.query('per_page') ?? '20', 10) || 20));

  const db = createDb(c.env.DATABASE_URL);

  const conditions: ReturnType<typeof and>[] = [eq(messageLog.businessId, businessId)];

  if (channelFilter) {
    conditions.push(eq(messageLog.channel, channelFilter));
  }

  if (customerId) {
    conditions.push(eq(messageLog.customerId, customerId));
  }

  if (statusFilter) {
    conditions.push(eq(messageLog.status, statusFilter));
  }

  const where = and(...conditions);

  const { total, items } = await withTenantTransaction(db, { businessId }, async (tx) => {
    const [totalResult] = await tx.select({ total: count() }).from(messageLog).where(where);

    // Each row carries its customer's name, so the history can say who it was
    // for. Joined on the business as well as the id: a customer row of another
    // tenant must never lend its name, whatever RLS is doing.
    const rows = await tx
      .select({ ...getTableColumns(messageLog), customerName: customers.fullName })
      .from(messageLog)
      .leftJoin(
        customers,
        and(eq(customers.id, messageLog.customerId), eq(customers.businessId, messageLog.businessId)),
      )
      .where(where)
      .orderBy(desc(messageLog.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage);

    return { total: Number(totalResult?.total ?? 0), items: rows };
  });

  return c.json({
    data: items,
    meta: { total, page, per_page: perPage },
  });
});

// ============================================================================
// Webhook: Meta verification (GET)
// ============================================================================

/**
 * GET /webhook
 *
 * Meta webhook verification endpoint.
 * Responds to the hub.challenge with the challenge value when
 * hub.mode=subscribe and hub.verify_token matches WHATSAPP_VERIFY_TOKEN.
 */
router.get('/webhook', async (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');

  if (mode === 'subscribe' && token === c.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  return c.json(
    {
      error: {
        code: 'VERIFICATION_FAILED',
        message: 'Verification token mismatch or invalid mode',
      },
    },
    403,
  );
});

// ============================================================================
// Webhook: Meta callbacks (POST)
// ============================================================================

/**
 * POST /webhook
 *
 * Receive Meta webhook callbacks:
 * - inbound messages → insert into message_log with direction='inbound'
 * - status callbacks → update message_log status by provider_message_id
 *
 * Always returns 200 OK to acknowledge receipt.
 */
router.post('/webhook', async (c) => {
  const body = await c.req.json<{
    entry?: Array<{
      id?: string;
      changes?: Array<{
        value?: {
          messaging_product?: string;
          metadata?: { phone_number_id?: string };
          messages?: Array<{
            from: string;
            id: string;
            text?: { body: string };
            type?: string;
            timestamp?: string;
          }>;
          statuses?: Array<{
            id: string;
            status: string;
            timestamp?: string;
            recipient_id?: string;
          }>;
        };
      }>;
    }>;
  }>();

  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  if (!value) {
    return c.json({ status: 'ok' }, 200);
  }

  // We need to resolve business_id from phone_number_id or similar context.
  // For now, we store inbound messages without business_id when context is
  // not available — the gateway auth bypass in PR 3 will resolve this.

  const db = createDb(c.env.DATABASE_URL);

  // Process inbound messages
  if (value.messages) {
    for (const msg of value.messages) {
      const customerPhone = msg.from;

      // Look up customer by phone to get customer_id + business_id. A phone is
      // unique per business, not across them, and the payload does not say
      // which business the message is for: two matches cannot be told apart,
      // so the message is skipped rather than logged against one of them.
      //
      // The tenant is not known until this lookup returns, so it runs on `db`,
      // across businesses, by necessity.
      const matches = await db
        .select({ id: customers.id, businessId: customers.businessId })
        .from(customers)
        .where(eq(customers.phone, customerPhone))
        .limit(2);

      if (matches.length > 1) {
        console.warn(
          `[communication] Inbound message ${msg.id} matches customers of several businesses — skipping`,
        );
        continue;
      }

      const [customer] = matches;
      if (!customer) {
        console.warn(
          `[communication] Inbound message from unknown phone ${customerPhone} — skipping`,
        );
        continue;
      }

      await withTenantTransaction(db, { businessId: customer.businessId }, (tx) =>
        tx.insert(messageLog).values({
          businessId: customer.businessId,
          customerId: customer.id,
          direction: 'inbound',
          channel: 'whatsapp',
          status: 'received',
          providerMessageId: msg.id,
          content: {
            text: msg.text?.body,
            type: msg.type,
            from: msg.from,
            timestamp: msg.timestamp,
          },
        }),
      );
    }
  }

  // Process status callbacks. A callback names only the provider's message id,
  // not the business, so there is no tenant to scope it to: these updates run
  // on `db`, across businesses, until the business is resolved from the
  // payload's phone_number_id.
  if (value.statuses) {
    for (const status of value.statuses) {
      await db
        .update(messageLog)
        .set({
          status: mapMetaStatus(status.status),
          metadata: { status_timestamp: status.timestamp },
        })
        .where(eq(messageLog.providerMessageId, status.id));
    }
  }

  return c.json({ status: 'ok' }, 200);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map Meta API status values to our internal message_log status values.
 */
function mapMetaStatus(metaStatus: string): string {
  switch (metaStatus) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
      return 'failed';
    default:
      return metaStatus;
  }
}

export default router;
