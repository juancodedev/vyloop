import type { Queue, Message, MessageBatch } from '@cloudflare/workers-types';

// ---------------------------------------------------------------------------
// Event type constants
// ---------------------------------------------------------------------------

export const CUSTOMER_REGISTERED = 'CustomerRegistered';
export const POINTS_ASSIGNED = 'PointsAssigned';
export const REWARD_REDEEMED = 'RewardRedeemed';
export const REWARD_AUTO_GRANTED = 'RewardAutoGranted';
// A customer was granted a reward that is redeemable at a named set of venues.
// Published by the growth worker after the grant row exists, consumed by the
// communication worker, which decides whether to push. It is a separate event
// from `RewardAutoGranted` because most grants are not venue-scoped: this one
// only exists when there is something to say about where the reward is good.
export const REWARD_AVAILABLE_AT_BRANCH = 'RewardAvailableAtBranch';
export const PROFILE_VIEWED = 'ProfileViewed';
export const QR_DISPLAYED = 'QRDisplayed';
export const WHATSAPP_OUTBOUND_REQUESTED = 'WhatsAppOutboundRequested';
export const PUSH_NOTIFICATION_REQUESTED = 'PushNotificationRequested';
export const WORKFLOW_TRIGGERED = 'WorkflowTriggered';
// A campaign a business composed: a target (a venue, or a centre and a radius)
// and the message to carry. The audience is resolved server-side, when the
// event is consumed — never by the caller, which never names a customer.
export const PUSH_CAMPAIGN_REQUESTED = 'PushCampaignRequested';
// A customer interacted with a venue. This is the fact a proximity audience is
// built from: there is no other record of a customer having been at a place.
export const CUSTOMER_CHECKED_IN = 'CustomerCheckedIn';

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
