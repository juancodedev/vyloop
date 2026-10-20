import {
  createDb,
  customerEvents,
  customers,
  readConsentMap,
  readPushSubscriptions,
} from '@vyloop/db';
import type { ConsentType } from '@vyloop/types';
import { and, eq, gte, inArray } from 'drizzle-orm';

import { findBranchesInRadius } from '../../../packages/db/src/proximity';

import type { Bindings } from './helpers';
import { withRls } from './helpers';
import { deliverPushNotification } from './push-delivery';

// ---------------------------------------------------------------------------
// Push campaigns.
//
// A campaign is a message a business composed and a target: a venue, or a
// centre and a radius. It is an event rather than a route call so that the
// work happens in the queue, and so that the composition — which touches
// every customer in the audience — never sits on a request's critical path.
//
// ## The audience is resolved here, never by the caller
//
// The route that composes a campaign never names a customer. It names a
// target, and the audience of that target is worked out from what actually
// happened: the customers with an interaction at the venue, or at any of the
// venues inside the radius. A caller that could name the audience would be a
// caller that could push to anybody.
//
// ## The interaction window
//
// A customer who was at a venue two years ago has not been there recently, and
// the campaign is about somewhere that is near them now. The window is a
// constant of this module and not a field of the request: a caller that could
// widen it would be asking for a different product, and a caller that could
// narrow it to a second would be reaching into a definition that belongs to
// the platform.
//
// ## The two gates
//
// Consent **and** a registered browser. A customer with the consent but no
// browser has nowhere to be reached; a customer with a browser but no consent
// has not agreed to be reached there. Either way the target is skipped, and
// the skip is counted rather than hidden: an operator that composed a campaign
// for two hundred people and reached forty needs to be able to see that.
//
// ## The delivery is the one that already exists
//
// `deliverPushNotification` re-checks the consent at the moment of the
// delivery, writes the `message_log` row and classifies what the push service
// answers. None of that is re-implemented here: a second delivery path is a
// second set of rules about when a subscription dies and what a `429` means.
// ---------------------------------------------------------------------------

/**
 * How long an interaction keeps a customer in a proximity audience.
 *
 * A hundred and eighty days: half a year. The spec asks for a "recent
 * interaction" (`docs/19-Geolocalizacion-Notificaciones.md`) and leaves the
 * number open; the product chose half a year so that occasional and seasonal
 * customers stay in the audience, while a customer who stopped coming a year
 * ago is still not pushed about a venue they have not been to since.
 */
export const INTERACTION_WINDOW_DAYS = 180;

/**
 * The consent a push campaign requires.
 *
 * Typed as a `ConsentType` so the compiler holds this module to the shared
 * vocabulary in `@vyloop/types` — `CONSENT_TYPES` — rather than to a string
 * that could drift from it.
 */
const PUSH_CONSENT_TYPE: ConsentType = 'nearby_notifications';

/** A campaign aimed at one venue. */
export interface PushCampaignBranchTarget {
  branch_id: string;
}

/** A campaign aimed at everything within a radius of a point. */
export interface PushCampaignRadiusTarget {
  latitude: number;
  longitude: number;
  radius_m: number;
}

/** Either of the two things a campaign can aim at. */
export type PushCampaignTarget = PushCampaignBranchTarget | PushCampaignRadiusTarget;

/** The payload of a `PushCampaignRequested` event. */
export interface PushCampaignPayload {
  business_id: string;
  title: string;
  body: string;
  url?: string;
  /**
   * The campaign's own reference. The operator's idempotency key: the same
   * campaign composed twice with the same reference is the same campaign.
   */
  reference_id?: string;
  target: PushCampaignBranchTarget | PushCampaignRadiusTarget;
}

/** What a campaign did. */
export interface PushCampaignOutcome {
  /** The customers the campaign resolved to. */
  audience: number;
  /** The browsers the message reached. */
  delivered: number;
  /** The deliveries that failed for good. */
  failed: number;
  /** The targets that could not be reached, and why they were counted here. */
  skipped: number;
}

/** A customer in a campaign's audience. */
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
      },
      businessId,
      env,
    );

    delivered += outcome.delivered;
    failed += outcome.failed;
  }

  return { audience: audience.length, delivered, failed, skipped };
}
