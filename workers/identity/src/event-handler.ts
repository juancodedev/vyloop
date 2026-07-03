import type { Message } from '@cloudflare/workers-types';
import type { EventEnvelope } from '@vyloop/event-bus';

/**
 * TestEvent consumer handler.
 *
 * Logs the received event and acknowledges it.
 * Used for development and end-to-end verification.
 */
export async function handleTestEvent(
  event: EventEnvelope,
  _message: Message<EventEnvelope>,
): Promise<void> {
  const payload = event.payload as { message?: string; data?: unknown } | undefined;

  console.log('[identity:event-handler] TestEvent received:', {
    id: event.id,
    type: event.type,
    business_id: event.header.business_id,
    timestamp: event.header.timestamp,
    message: payload?.message,
    data: payload?.data,
  });

  // For PMV: just log and ack.
  // In production: could trigger notifications, update dashboards, etc.
}
