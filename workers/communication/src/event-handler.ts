import type { Message } from '@cloudflare/workers-types';
import { createDb, messageLog, customers } from '@vyloop/db';
import { CUSTOMER_CHECKED_IN, PUSH_CAMPAIGN_REQUESTED, REWARD_AVAILABLE_AT_BRANCH } from '@vyloop/event-bus';
import type { EventEnvelope } from '@vyloop/event-bus';
import { logPrefix } from '@vyloop/request-context';
import { eq, and } from 'drizzle-orm';

import type { Bindings } from './helpers';
import { withRls, callMetaApi, isRetryableError } from './helpers';
import { handlePushCampaignRequested, type PushCampaignPayload } from './push-campaigns';
import { deliverPushNotification, type PushNotificationPayload } from './push-delivery';
import {
  handleRewardAvailableAtBranch,
  type RewardAvailableAtBranchPayload,
} from './reward-notifications';

// ---------------------------------------------------------------------------
// Queue consumer dispatcher
// ---------------------------------------------------------------------------

/**
 * Handle a single domain event from the queue.
 *
 * For now, only WhatsAppOutboundRequested is handled. Events not matching
 * a known type are logged and acked to avoid blocking the queue.
 */
/**
 * Log prefix for a queued event. The id travels in the envelope, so a failure
 * here is traceable back to the request that produced the event.
 */
function tag(event: EventEnvelope): string {
  const requestId = event.header.request_id;
  return requestId ? logPrefix('communication', requestId) : '[communication]';
}


export async function handleEvent(
  event: EventEnvelope,
  message: Message<EventEnvelope>,
  env: Bindings,
): Promise<void> {
  switch (event.type) {
    case 'WhatsAppOutboundRequested':
      return handleWhatsAppOutboundRequested(event, message, env);
    case 'PushNotificationRequested':
      return handlePushNotificationRequested(event, env);
    case PUSH_CAMPAIGN_REQUESTED:
      return handlePushCampaignRequestedEvent(event, env);
    case CUSTOMER_CHECKED_IN:
      // Recorded for the venue association; no message is owed for a check-in.
      return;
    case REWARD_AVAILABLE_AT_BRANCH:
      return handleRewardAvailableAtBranchEvent(event, env);
    default:
      console.warn(`${tag(event)} Unknown event type: ${event.type} — acking and skipping`);
      return;
  }
}

// ---------------------------------------------------------------------------
// RewardAvailableAtBranch handler
// ---------------------------------------------------------------------------

/**
 * Announce a reward that is only redeemable at some venues.
 *
 * The cap and the consent live in `reward-notifications`; this wrapper only
 * takes the tenant from the envelope, which is what makes the handler's own
 * reads tenant-scoped.
 */
async function handleRewardAvailableAtBranchEvent(
  event: EventEnvelope,
  env: Bindings,
): Promise<void> {
  const payload = event.payload as RewardAvailableAtBranchPayload;

  await handleRewardAvailableAtBranch(payload, event.header.business_id, env);
}

// ---------------------------------------------------------------------------
// WhatsAppOutboundRequested handler
// ---------------------------------------------------------------------------

/**
 * Handle a WhatsAppOutboundRequested event.
 *
 * 1. Read the message_log entry by idempotency key
 * 2. Skip if already sent (status != 'queued')
 * 3. Resolve the customer's phone number
 * 4. Call Meta Graph API to send the template
 * 5. On success: update message_log status='sent', store provider_message_id
 * 6. On 429: leave as 'queued', let queue retry
 * 7. On 4xx: update status='failed', store error in metadata
 */
async function handleWhatsAppOutboundRequested(
  event: EventEnvelope,
  _message: Message<EventEnvelope>,
  env: Bindings,
): Promise<void> {
  const payload = event.payload as {
    customer_id: string;
    business_id: string;
    template_name: string;
    parameters: Record<string, string>;
    idempotency_key: string;
    phone?: string;
  };

  const businessId = event.header.business_id;

  const db = createDb(env.DATABASE_URL);
  await withRls(db, businessId);

  // -----------------------------------------------------------------------
  // Read message_log by idempotency_key
  // -----------------------------------------------------------------------
  const [logEntry] = await db
    .select()
    .from(messageLog)
    .where(
      and(
        eq(messageLog.businessId, businessId),
        eq(messageLog.id, payload.idempotency_key),
      ),
    )
    .limit(1);

  if (!logEntry) {
    console.warn(
      `${tag(event)} message_log entry ${payload.idempotency_key} not found — acking`,
    );
    return;
  }

  // Idempotency: skip if already sent or failed permanently
  if (logEntry.status !== 'queued') {
    console.log(
      `${tag(event)} message_log ${payload.idempotency_key} already ${logEntry.status} — skipping`,
    );
    return;
  }

  // -----------------------------------------------------------------------
  // Resolve phone number
  // -----------------------------------------------------------------------
  let phone = payload.phone;

  if (!phone) {
    const [customer] = await db
      .select({ phone: customers.phone })
      .from(customers)
      .where(
        and(eq(customers.businessId, businessId), eq(customers.id, payload.customer_id)),
      )
      .limit(1);

    phone = customer?.phone ?? undefined;
  }

  if (!phone) {
    console.warn(
      `${tag(event)} No phone for customer ${payload.customer_id} — marking failed`,
    );
    await db
      .update(messageLog)
      .set({
        status: 'failed',
        metadata: {
          ...(logEntry.metadata as Record<string, unknown> ?? {}),
          error: 'No phone number available',
        },
      })
      .where(eq(messageLog.id, logEntry.id));
    return;
  }

  // -----------------------------------------------------------------------
  // Call Meta API
  // -----------------------------------------------------------------------
  try {
    const response = await callMetaApi(env, phone, payload.template_name, payload.parameters);

    if (response.ok) {
      // Extract provider_message_id from response body
      const responseBody = await response.json() as { messages?: Array<{ id: string }> };
      const providerMessageId = responseBody.messages?.[0]?.id;

      await db
        .update(messageLog)
        .set({
          status: 'sent',
          providerMessageId: providerMessageId ?? null,
        })
        .where(eq(messageLog.id, logEntry.id));

      console.log(
        `${tag(event)} Message ${logEntry.id} sent via Meta — provider ID: ${providerMessageId}`,
      );
    } else {
      // Determine error handling based on status
      const responseBody = await response.json() as { error?: { code?: number; message?: string } };
      const errorCode = responseBody.error?.code ?? response.status;

      if (isRetryableError({ status: response.status, code: errorCode })) {
        // Leave as 'queued' — queue will retry
        console.warn(
          `${tag(event)} Meta API retryable error (${response.status}) for ${logEntry.id} — leaving queued`,
        );
        // Throw to trigger queue retry
        throw new Error(`Meta API retryable error: ${response.status}`);
      }

      // Non-retryable 4xx error — mark as failed permanently
      await db
        .update(messageLog)
        .set({
          status: 'failed',
          metadata: {
            ...(logEntry.metadata as Record<string, unknown> ?? {}),
            error: responseBody.error?.message ?? `Meta API returned ${response.status}`,
            error_code: response.status,
          },
        })
        .where(eq(messageLog.id, logEntry.id));

      console.error(
        `${tag(event)} Message ${logEntry.id} failed permanently — Meta error: ${responseBody.error?.message ?? response.status}`,
      );
    }
  } catch (err) {
    // Network or unexpected error — retry
    console.error(
      `${tag(event)} Unexpected error sending message ${logEntry.id}:`,
      err,
    );
    throw err; // Triggers queue retry
  }
}


// ---------------------------------------------------------------------------
// PushNotificationRequested handler
// ---------------------------------------------------------------------------

/**
 * Handle a PushNotificationRequested event.
 *
 * The delivery itself, the classification of what the push service answers,
 * and the consent check that runs again at the moment of the delivery, all
 * live in `push-delivery.ts`. This handler is the seam: it takes the event
 * apart and hands the payload over.
 */
async function handlePushNotificationRequested(
  event: EventEnvelope,
  env: Bindings,
): Promise<void> {
  const payload = event.payload as PushNotificationPayload;
  const businessId = event.header.business_id;

  const outcome = await deliverPushNotification(payload, businessId, env);

  console.log(
    `${tag(event)} Push to ${payload.customer_id}: ${outcome.delivered} delivered, ` +
      `${outcome.failed} failed, ${outcome.removed} dead subscriptions removed ` +
      `of ${outcome.subscriptions}`,
  );
}

// ---------------------------------------------------------------------------
// PushCampaignRequested handler
// ---------------------------------------------------------------------------

async function handlePushCampaignRequestedEvent(
  event: EventEnvelope,
  env: Bindings,
): Promise<void> {
  const payload = event.payload as PushCampaignPayload;
  const businessId = event.header.business_id;

  const outcome = await handlePushCampaignRequested(payload, businessId, env);

  console.log(
    `${tag(event)} Push campaign ${payload.reference_id ?? '(no reference)'}: ` +
      `web_push: ${outcome.web_push.delivered} delivered, ${outcome.web_push.failed} failed, ${outcome.web_push.skipped} skipped; ` +
      `wallet: ${outcome.wallet.delivered} delivered, ${outcome.wallet.failed} failed, ${outcome.wallet.skipped} skipped`,
  );
}
