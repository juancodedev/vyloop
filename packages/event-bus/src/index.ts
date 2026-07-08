import type { Queue, Message, MessageBatch } from '@cloudflare/workers-types';

// ---------------------------------------------------------------------------
// Event type constants
// ---------------------------------------------------------------------------

export const CUSTOMER_REGISTERED = 'CustomerRegistered';
export const POINTS_ASSIGNED = 'PointsAssigned';
export const REWARD_REDEEMED = 'RewardRedeemed';
export const REWARD_AUTO_GRANTED = 'RewardAutoGranted';
export const PROFILE_VIEWED = 'ProfileViewed';
export const QR_DISPLAYED = 'QRDisplayed';

// ---------------------------------------------------------------------------
// Event envelope format
// ---------------------------------------------------------------------------

export interface EventEnvelope {
  id: string;
  type: string;
  source: string;
  specversion: string;
  time: string;
  header: {
    business_id: string;
    timestamp: string;
    localization?: {
      country?: string;
      currency?: string;
      timezone?: string;
      language?: string;
    };
  };
  payload: unknown;
}

export interface EventHandler {
  (event: EventEnvelope, message: Message<EventEnvelope>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * Publish an event to a Cloudflare Queue.
 *
 * @param queue   The Queue binding (available as `env.QUEUE_NAME`).
 * @param event   The event envelope to publish (must include id, type, header, payload).
 */
export async function publish(
  queue: Queue,
  event: EventEnvelope,
): Promise<void> {
  await queue.send(event, { contentType: 'json' });
}

/**
 * Publish multiple events as a batch.
 */
export async function publishBatch(
  queue: Queue,
  events: EventEnvelope[],
): Promise<void> {
  await queue.sendBatch(events.map((e) => ({ body: e, contentType: 'json' as const })));
}

// ---------------------------------------------------------------------------
// Consume
// ---------------------------------------------------------------------------

/**
 * Create a consumer handler that wraps the user-provided handler with
 * ack/retry logic.
 *
 * Usage (in a Worker's `queue` export):
 * ```ts
 * import { consume } from '@vyloop/event-bus';
 * import { handleTestEvent } from './event-handler';
 *
 * export default {
 *   async queue(batch, env) {
 *     await consume(batch, handleTestEvent);
 *   },
 * };
 * ```
 *
 * @param batch   The MessageBatch from the Worker's `queue` handler.
 * @param handler The user's event handler. It receives the parsed event and
 *                the message (for ack/retry). If it throws, the message is
 *                automatically retried (at-least-once delivery).
 */
export async function consume(
  batch: MessageBatch<EventEnvelope>,
  handler: EventHandler,
): Promise<void> {
  const results = batch.messages.map(async (msg) => {
    try {
      await handler(msg.body, msg);
      msg.ack();
    } catch (err) {
      console.error(
        `[event-bus] Error processing event ${msg.body?.id ?? 'unknown'}:`,
        err,
      );
      msg.retry();
    }
  });

  await Promise.allSettled(results);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a standard event envelope with sensible defaults.
 */
export function createEnvelope(
  type: string,
  header: EventEnvelope['header'],
  payload: unknown,
): EventEnvelope {
  return {
    id: crypto.randomUUID(),
    type,
    source: 'vyloop.gateway',
    specversion: '1.0',
    time: new Date().toISOString(),
    header,
    payload,
  };
}
