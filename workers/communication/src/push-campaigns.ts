import {
  createDb,
  customerEvents,
  customers,
  readConsentMap,
  readPushSubscriptions,
  customerWalletPasses,
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
import { customerWalletPasses as customerWalletPassesTable } from '@vyloop/db';

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
 * Deliver a campaign to its audience.
 *
 * One delivery per target, through the delivery that already exists. The
 * reference the delivery writes into `message_log` is
 * `<campaign reference id>:<subscription id>`, so the rows of one campaign
 * share a prefix and the campaign's own reference never blocks the other
 * subscribers of that campaign.
 *
 * A throw from the delivery is not caught: the push service asking us to
 * slow down (`429`) has to be retried by the queue, and a campaign that
 * swallowed the retry would drop the message.
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

  let delivered = 0;
  let failed = 0;
  let skipped = 0;

  for (const member of audience) {
    const consents = await readConsentMap(db, {
      businessId,
      customerId: member.customerId,
    });

    if (consents[PUSH_CONSENT_TYPE] !== true) {
      skipped += 1;
      continue;
    }

    const subscriptions = await readPushSubscriptions(db, {
      businessId,
      customerId: member.customerId,
    });

    if (subscriptions.length === 0) {
      skipped += 1;
      continue;
    }

    const outcome = await deliverPushNotification(
      {
        customer_id: member.globalId,
        business_id: businessId,
        title: payload.title,
        body: payload.body,
        ...(payload.url !== undefined ? { url: payload.url } : {}),
        // The campaign's own reference. The delivery appends each browser's
        // subscription id, which makes `<campaign>:<subscription>`.
        reference_id: campaignReferenceId,
        target: payload.target,
        target_type: 'branch_id' in payload.target ? 'branch' : 'radius',
        audience_size: audience.length,
      },
      businessId,
      env,
    );

    delivered += outcome.delivered;
    failed += outcome.failed;

    // Also send Google Wallet push notification if customer has a saved pass
    try {
      const pass = await db
        .select({ objectId: customerWalletPassesTable.objectId })
        .from(customerWalletPassesTable)
        .where(
          and(
            eq(customerWalletPassesTable.customerId, member.customerId),
            eq(customerWalletPassesTable.tenantId, businessId),
            eq(customerWalletPassesTable.state, 'issued'),
          ),
        )
        .limit(1);

      if (pass.length > 0) {
        const objectId = pass[0].objectId;
        // Call wallet worker's push-notifications endpoint
        const walletUrl = env.WALLET_WORKER_URL || 'https://wallet.cl-jmunoz.workers.dev';
        await fetch(walletUrl + '/v1/wallet/push-notifications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + env.WALLET_SERVICE_TOKEN,
          },
          body: JSON.stringify({
            notifications: [{
              title: payload.title,
              body: payload.body,
              ...(payload.url !== undefined ? { url: payload.url } : {}),
              offerId: campaignReferenceId,
            }],
          }),
        });
      }
    } catch (err) {
      // Log but don't fail the campaign if wallet notification fails
      console.error('Failed to send Google Wallet notification:', err);
    }
  }

  return { audience: audience.length, delivered, failed, skipped };
}