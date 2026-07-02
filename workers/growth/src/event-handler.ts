import type { Message } from '@cloudflare/workers-types';
import type { EventEnvelope } from '@vyloop/event-bus';
import type { Bindings } from './helpers';

// ---------------------------------------------------------------------------
// Queue consumer dispatcher
// ---------------------------------------------------------------------------

/**
 * Handle a single domain event from the queue.
 *
 * This function is called by the `consume()` wrapper from @vyloop/event-bus,
 * which provides ack/retry semantics automatically.
 *
 * Phase 3 will implement the actual handlers for:
 * - CustomerRegistered → wallet init + Bronze tier assignment
 * - PointsAssigned → tier upgrade evaluation
 *
 * Currently dispatches to individual handlers based on event type.
 * Events not matching a known type are logged and acked to avoid
 * blocking the queue.
 */
export async function handleEvent(
  event: EventEnvelope,
  message: Message<EventEnvelope>,
  env: Bindings,
): Promise<void> {
  switch (event.type) {
    case 'CustomerRegistered':
      return handleCustomerRegistered(event, message, env);
    case 'PointsAssigned':
      return handlePointsAssigned(event, message, env);
    default:
      console.warn(`[growth] Unknown event type: ${event.type} — acking and skipping`);
      return;
  }
}

// ---------------------------------------------------------------------------
// Event handlers (placeholders — Phase 3 will fill these)
// ---------------------------------------------------------------------------

async function handleCustomerRegistered(
  event: EventEnvelope,
  _message: Message<EventEnvelope>,
  _env: Bindings,
): Promise<void> {
  console.warn(
    '[growth] CustomerRegistered handler not yet implemented (Phase 3) — skipping for event',
    event.id,
  );
}

async function handlePointsAssigned(
  event: EventEnvelope,
  _message: Message<EventEnvelope>,
  _env: Bindings,
): Promise<void> {
  console.warn(
    '[growth] PointsAssigned handler not yet implemented (Phase 3) — skipping for event',
    event.id,
  );
}
