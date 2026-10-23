import {
  createDb,
  customerEvents,
  customers,
  readConsentMap,
  readPushSubscriptions,
  customerWalletPasses as _customerWalletPasses,
} from '@vyloop/db';
import type { ConsentType } from '@vyloop/types';
import { and, eq, gte, inArray } from 'drizzle-orm';

import { findBranchesInRadius } from '../../../packages/db/src/proximity';

import type { Bindings } from './helpers';
declare module './helpers' {
  interface Bindings {
    WALLET_WORKER_URL?: string;
    WALLET_SERVICE_TOKEN?: string;
  }
}
import { withRls } from './helpers';
import { deliverPushNotification } from './push-delivery';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PUSH_CONSENT_TYPE: ConsentType = 'nearby_notifications';

export const INTERACTION_WINDOW_DAYS = 180;

export interface PushCampaignBranchTarget {
  branch_id: string;
}

export interface PushCampaignRadiusTarget {
  latitude: number;
  longitude: number;
  radius_m: number;
}

export type PushCampaignTarget = PushCampaignBranchTarget | PushCampaignRadiusTarget;

export interface PushCampaignPayload {
  title: string;
  body: string;
  url?: string;
  reference_id?: string;
  target: PushCampaignTarget;
  business_id?: string;
}

export interface PushCampaignOutcome {
  audience: number;
  web_push: ChannelOutcome;
  wallet: ChannelOutcome;
}

export interface ChannelOutcome {
  delivered: number;
  failed: number;
  skipped: number;
}

export interface CampaignAudienceMember {
  /** The internal id, `customers.id`. */
  customerId: string;
  /** The global id, `customers.globalId` — what a push delivery resolves. */
  globalId: string;
}

/**
 * The venues a campaign targets.
 *
 * A venue target is the venue it names. A radius target is the venues inside
 * the radius, resolved with the two-stage proximity query: the geohash prefix
 * as the coarse filter, the exact distance as the fine one.
 */
async function resolveTargetBranches(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  businessId: string,
  target: PushCampaignTarget,
): Promise<string[]> {
  if ('branch_id' in target) {
    return [target.branch_id];
  }

  const branches = await findBranchesInRadius(db, {
    businessId,
    latitude: target.latitude,
    longitude: target.longitude,
    radiusMeters: target.radius_m,
  });

  return branches.map((branch) => branch.id);
}

/**
 * The customers a campaign targets.
 *
 * The customers with an interaction at one of the target's venues, inside the
 * interaction window, deduplicated: a customer who was at two of the venues
 * is one customer, and a message sent to them twice is two messages.
 *
 * The **global** id is what comes back, because that is the id a push
 * delivery resolves. The interaction table holds the internal one, and the
 * two are not interchangeable.
 */
export async function resolveCampaignAudience(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  businessId: string,
  target: PushCampaignTarget,
): Promise<CampaignAudienceMember[]> {
  const branchIds = await resolveTargetBranches(db, businessId, target);

  if (branchIds.length === 0) {
    return [];
  }

  const since = new Date(Date.now() - INTERACTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      customerId: customerEvents.customerId,
      globalId: customers.globalId,
    })
    .from(customerEvents)
    .innerJoin(customers, eq(customerEvents.customerId, customers.id))
    .where(
      and(
        eq(customerEvents.businessId, businessId),
        inArray(customerEvents.branchId, branchIds),
        gte(customerEvents.createdAt, since),
      ),
    );

  const members = new Map<string, CampaignAudienceMember>();

  for (const row of rows as { customerId: string; globalId: string }[]) {
    if (!members.has(row.customerId)) {
      members.set(row.customerId, { customerId: row.customerId, globalId: row.globalId });
    }
  }

  return [...members.values()];
}

/**
 * Deliver web push notifications to a single audience member.
 *
 * A throw from the delivery is not caught: the push service asking us to
 * slow down (`429`) has to be retried by the queue, and a campaign that
 * swallowed the retry would drop the message.
 */
async function deliverWebPushChannel(
  member: CampaignAudienceMember,
  payload: PushCampaignPayload,
  campaignReferenceId: string,
  businessId: string,
  audienceSize: number,
  env: Bindings,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<ChannelOutcome> {
  const subscriptions = await readPushSubscriptions(db, {
    businessId,
    customerId: member.customerId,
  });

  if (subscriptions.length === 0) {
    return { delivered: 0, failed: 0, skipped: 1 };
  }

  const outcome = await deliverPushNotification(
    {
      customer_id: member.globalId,
      business_id: businessId,
      title: payload.title,
      body: payload.body,
      ...(payload.url !== undefined ? { url: payload.url } : {}),
      reference_id: campaignReferenceId,
      target: payload.target,
      target_type: 'branch_id' in payload.target ? 'branch' : 'radius',
      audience_size: audienceSize,
    },
    businessId,
    env,
  );

  return {
    delivered: outcome.delivered,
    failed: outcome.failed,
    skipped: 0,
  };
}

/**
 * Deliver Google Wallet push notification to a single audience member.
 */
async function deliverWalletChannel(
  member: CampaignAudienceMember,
  payload: PushCampaignPayload,
  campaignReferenceId: string,
  businessId: string,
  env: Bindings,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<ChannelOutcome> {
  try {
    const pass = await db
      .select({ objectId: _customerWalletPasses.objectId })
      .from(_customerWalletPasses)
      .where(
        and(
          eq(_customerWalletPasses.customerId, member.customerId),
          eq(_customerWalletPasses.tenantId, businessId),
          eq(_customerWalletPasses.state, 'issued'),
        ),
      )
      .limit(1);

    if (pass.length === 0) {
      return { delivered: 0, failed: 0, skipped: 1 };
    }

    const response = await env.wallet.fetch('https://wallet.internal/v1/wallet/push-notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Business-Id': businessId,
        'X-User-Id': 'communication-worker',
        'X-User-Role': 'service',
      },
      body: JSON.stringify({
        customer_id: member.globalId,
        notifications: [{
          title: payload.title,
          body: payload.body,
          ...(payload.url !== undefined ? { url: payload.url } : {}),
          offerId: campaignReferenceId,
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // 409 PASS_NOT_ISSUED means no issued pass for this customer → skip, not fail
      if (response.status === 409 && text.includes('PASS_NOT_ISSUED')) {
        return { delivered: 0, failed: 0, skipped: 1 };
      }
      const msg = `Wallet push failed: ${response.status} ${text}`;
      console.error('Wallet push error:', msg);
      throw new Error(msg);
    }

    return { delivered: 1, failed: 0, skipped: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Failed to send Google Wallet notification:', message);
    return { delivered: 0, failed: 1, skipped: 0 };
  }
}

/**
 * Deliver a campaign to its audience.
 *
 * Two independent channels per member: a browser push and a Google Wallet
 * notification. Their counters are reported separately, so a member with no
 * browser subscription is still counted as reached when the wallet delivers,
 * and a wallet failure never hides a successful push.
 *
 * The reference the push delivery writes into `message_log` is
 * `<campaign reference id>:<subscription id>`, so the rows of one campaign
 * share a prefix and the campaign's own reference never blocks the other
 * subscribers of that campaign.
 */
export async function handlePushCampaignRequested(
  payload: PushCampaignPayload,
  businessId: string,
  env: Bindings,
): Promise<PushCampaignOutcome> {
  const db = createDb(env.DATABASE_URL);
  await withRls(db, businessId);

  const audience = await resolveCampaignAudience(db, businessId, payload.target);

  // A campaign without a reference of its own still needs one: the reference
  // is what names its rows, and what the composing route refuses to repeat.
  const campaignReferenceId = payload.reference_id ?? crypto.randomUUID();

  const webPush = { delivered: 0, failed: 0, skipped: 0 };
  const wallet = { delivered: 0, failed: 0, skipped: 0 };

  for (const member of audience) {
    const consents = await readConsentMap(db, {
      businessId,
      customerId: member.customerId,
    });

    if (consents[PUSH_CONSENT_TYPE] !== true) {
      webPush.skipped += 1;
      wallet.skipped += 1;
      continue;
    }

    // Channel 1: Web Push (browser)
    const webPushResult = await deliverWebPushChannel(
      member,
      payload,
      campaignReferenceId,
      businessId,
      audience.length,
      env,
      db,
    );
    webPush.delivered += webPushResult.delivered;
    webPush.failed += webPushResult.failed;
    webPush.skipped += webPushResult.skipped;

    // Channel 2: Google Wallet (independent)
    const walletResult = await deliverWalletChannel(
      member,
      payload,
      campaignReferenceId,
      businessId,
      env,
      db,
    );
    wallet.delivered += walletResult.delivered;
    wallet.failed += walletResult.failed;
    wallet.skipped += walletResult.skipped;
  }

  return {
    audience: audience.length,
    web_push: webPush,
    wallet,
  };
}
