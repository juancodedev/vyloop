import type { KVNamespace } from '@cloudflare/workers-types';
import { publish, createEnvelope } from '@vyloop/event-bus';
import { validate } from '@vyloop/schema-registry';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestorEnv {
  SCHEMA_REGISTRY: KVNamespace;
  EVENT_QUEUE: Queue;
  // For hosted event types that need specific queues
  DOMAIN_EVENTS_QUEUE: Queue;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const ingestor = new Hono<{ Bindings: IngestorEnv }>();

/**
 * POST /v1/events/{type}
 *
 * Validates the event payload against the Schema Registry, then publishes
 * to the event queue.
 *
 * Responses:
 * - 202 Accepted — event validated and published
 * - 400 SCHEMA_INVALID — payload does not match schema
 * - 404 EVENT_TYPE_UNKNOWN — no schema registered for this event type
 */
ingestor.post('/v1/events/:type', async (c) => {
  const eventType = c.req.param('type');
  const kv = c.env.SCHEMA_REGISTRY;

  // Validate content type
  const contentType = c.req.header('Content-Type');
  if (!contentType?.includes('application/json')) {
    return c.json(
      {
        error: {
          code: 'SCHEMA_INVALID',
          message: 'Content-Type must be application/json',
          request_id: crypto.randomUUID(),
        },
      },
      400,
    );
  }

  let body: { header?: Record<string, unknown>; payload?: unknown };
  try {
    body = await c.req.json<{ header?: Record<string, unknown>; payload?: unknown }>();
  } catch {
    return c.json(
      {
        error: {
          code: 'SCHEMA_INVALID',
          message: 'Invalid JSON body',
          request_id: crypto.randomUUID(),
        },
      },
      400,
    );
  }

  // Validate against the schema registry
  const result = await validate(kv, eventType, body);

  if (!result.valid) {
    // Determine if it's a "schema not found" case (404) or "invalid payload" (400)
    const isUnknown = result.errors?.some((e) => e.includes('Schema not found'));
    if (isUnknown) {
      return c.json(
        {
          error: {
            code: 'EVENT_TYPE_UNKNOWN',
            message: `No schema registered for event type: "${eventType}"`,
            request_id: crypto.randomUUID(),
          },
        },
        404,
      );
    }

    return c.json(
      {
        error: {
          code: 'SCHEMA_INVALID',
          message: 'Event payload does not match schema',
          details: result.errors,
          request_id: crypto.randomUUID(),
        },
      },
      400,
    );
  }

  // Extract header info for the envelope
  const header: { business_id: string; timestamp: string; localization?: { country?: string; currency?: string; timezone?: string; language?: string } } = {
    business_id: (body.header?.business_id as string) ?? 'unknown',
    timestamp: (body.header?.timestamp as string) ?? new Date().toISOString(),
  };
  if (body.header?.localization) {
    header.localization = body.header.localization as { country?: string; currency?: string; timezone?: string; language?: string };
  }

  // Create the standard event envelope
  const envelope = createEnvelope(eventType, header, body.payload);

  // Publish to the appropriate queue
  // - TestEvent goes to EVENT_QUEUE (dev)
  // - Domain events go to DOMAIN_EVENTS_QUEUE
  const queue = eventType === 'test_event' ? c.env.EVENT_QUEUE : c.env.DOMAIN_EVENTS_QUEUE;
  await publish(queue, envelope);

  return c.json(
    {
      accepted: true,
      event_id: envelope.id,
      event_type: eventType,
    },
    202,
  );
});

/**
 * GET /v1/events/health
 */
ingestor.get('/v1/events/health', async (c) => {
  return c.json({ status: 'ok', service: 'event-ingestor' });
});

export { ingestor };
