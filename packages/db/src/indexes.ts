import { getTableConfig, Index as DrizzleIndex, type PgTable } from 'drizzle-orm/pg-core';

import {
  branches,
  consents,
  customers,
  pushSubscriptions,
  customerEvents,
  pointsTransactions,
  rewards,
  rewardGrants,
  rewardBranches,
  messageLog,
  whatsappTemplates,
  customerWalletPasses,
  walletCallbackDeliveries,
  posTerminals,
  pushCampaigns,
} from './schema';

// ---------------------------------------------------------------------------
// Derived index registry.
//
// This module used to *declare* the indexes. It no longer does: the index
// builders now live in each table's extra-config callback in `schema.ts`,
// because drizzle-kit only emits `CREATE INDEX` for an index that a table has
// claimed. See the comment block at the top of `schema.ts` for the measurement
// behind that change and for the `drizzle.config.ts` alternative that was
// tried and rejected as a no-op.
//
// What lives here is a *read* of the built table configs, so this file cannot
// drift from the schema: if an index is removed from a callback, the lookup
// below throws instead of exporting a stale builder. The named exports are kept
// because they are part of the package's public surface (`@vyloop/db`).
// ---------------------------------------------------------------------------

/**
 * Every table that declares at least one index. Order is irrelevant for the
 * registry's contents but kept stable so `allIndexes` has a deterministic
 * order and snapshots of it are comparable.
 */
const INDEXED_TABLES: readonly PgTable[] = [
  branches,
  consents,
  customers,
  pushSubscriptions,
  pointsTransactions,
  customerEvents,
  rewards,
  rewardGrants,
  rewardBranches,
  messageLog,
  whatsappTemplates,
  customerWalletPasses,
  walletCallbackDeliveries,
  posTerminals,
  pushCampaigns,
];

/**
 * Every index the schema declares, in table order and then declaration order.
 */
export const allIndexes: readonly DrizzleIndex[] = INDEXED_TABLES.flatMap(
  (table) => getTableConfig(table).indexes,
);

/**
 * The SQL index name for each public export, so a reader can see the mapping
 * between the exported binding and the name that reaches the database without
 * opening `schema.ts`.
 */
const INDEX_NAMES = {
  idxBranchesGeohash: 'idx_branches_geohash',
  uqConsentsCustomerType: 'uq_consents_customer_type',
  uqPushSubscriptionsEndpoint: 'uq_push_subscriptions_endpoint',
  idxPushSubscriptionsBusiness: 'idx_push_subscriptions_business',
  idxPushSubscriptionsCustomer: 'idx_push_subscriptions_customer',
  idxPushSubscriptionsLastSeen: 'idx_push_subscriptions_last_seen',
  idxCustomersPhone: 'idx_customers_phone',
  idxCustomersLastVisit: 'idx_customers_last_visit',
  idxPointsBalance: 'idx_points_balance',
  idxCustomersMetadata: 'idx_customers_metadata',
  idxCustomerEventsCustomer: 'idx_customer_events_customer',
  idxCustomerEventsType: 'idx_customer_events_type',
  idxCustomerEventsBranch: 'idx_customer_events_branch',
  idxRewardsCategory: 'idx_rewards_category',
  idxRewardsAutoGrant: 'idx_rewards_auto_grant',
  idxRewardGrantsCustomer: 'idx_reward_grants_customer',
  idxRewardBranchesBranch: 'idx_reward_branches_branch',
  idxMessageLogCustomer: 'idx_message_log_customer',
  idxMessageLogStatus: 'idx_message_log_status',
  idxWhatsappTemplatesName: 'idx_whatsapp_templates_name',
  idxCustomersMemberCode: 'uq_customers_business_member_code',
  idxCustomerWalletPassesTenant: 'idx_customer_wallet_passes_tenant',
  idxWalletCallbackDeliveriesReceived: 'idx_wallet_callback_deliveries_received',
  idxPosTerminalsBusiness: 'idx_pos_terminals_business',
  idxPushCampaignsBusiness: 'idx_push_campaigns_business',
} as const satisfies Record<string, string>;

/**
 * Resolve a built index by its SQL name.
 *
 * Throws rather than returning `undefined` on a miss. A missing index is a
 * schema-level defect, and a silent `undefined` here would turn a declaration
 * mistake into a runtime `TypeError` somewhere far from its cause.
 */
export function indexByName(name: string): DrizzleIndex {
  const found = allIndexes.find((index) => index.config.name === name);
  if (!found) {
    throw new Error(
      `No index named "${name}" is declared in the schema. ` +
        `Declared indexes: ${allIndexes.map((i) => i.config.name).join(', ')}`,
    );
  }
  return found;
}

export const idxBranchesGeohash = indexByName(INDEX_NAMES.idxBranchesGeohash);
export const uqConsentsCustomerType = indexByName(INDEX_NAMES.uqConsentsCustomerType);
export const uqPushSubscriptionsEndpoint = indexByName(INDEX_NAMES.uqPushSubscriptionsEndpoint);
export const idxPushSubscriptionsBusiness = indexByName(INDEX_NAMES.idxPushSubscriptionsBusiness);
export const idxPushSubscriptionsCustomer = indexByName(INDEX_NAMES.idxPushSubscriptionsCustomer);
export const idxPushSubscriptionsLastSeen = indexByName(INDEX_NAMES.idxPushSubscriptionsLastSeen);
export const idxCustomersPhone = indexByName(INDEX_NAMES.idxCustomersPhone);
export const idxCustomersLastVisit = indexByName(INDEX_NAMES.idxCustomersLastVisit);
export const idxPointsBalance = indexByName(INDEX_NAMES.idxPointsBalance);
export const idxCustomersMetadata = indexByName(INDEX_NAMES.idxCustomersMetadata);
export const idxCustomerEventsCustomer = indexByName(INDEX_NAMES.idxCustomerEventsCustomer);
export const idxCustomerEventsType = indexByName(INDEX_NAMES.idxCustomerEventsType);
export const idxCustomerEventsBranch = indexByName(INDEX_NAMES.idxCustomerEventsBranch);
export const idxRewardsCategory = indexByName(INDEX_NAMES.idxRewardsCategory);
export const idxRewardsAutoGrant = indexByName(INDEX_NAMES.idxRewardsAutoGrant);
export const idxRewardGrantsCustomer = indexByName(INDEX_NAMES.idxRewardGrantsCustomer);
export const idxRewardBranchesBranch = indexByName(INDEX_NAMES.idxRewardBranchesBranch);
export const idxMessageLogCustomer = indexByName(INDEX_NAMES.idxMessageLogCustomer);
export const idxMessageLogStatus = indexByName(INDEX_NAMES.idxMessageLogStatus);
export const idxWhatsappTemplatesName = indexByName(INDEX_NAMES.idxWhatsappTemplatesName);
export const idxCustomersMemberCode = indexByName(INDEX_NAMES.idxCustomersMemberCode);
export const idxCustomerWalletPassesTenant = indexByName(INDEX_NAMES.idxCustomerWalletPassesTenant);

/**
 * Supports pruning old deliveries by age.
 *
 * Exported for the same reason as every other index here: the registry's
 * invariant is that a declared index has a named binding, and a table added to
 * `INDEXED_TABLES` without one would break the exact-set assertion in
 * `index.test.ts` in a way that reads as drift rather than as an omission.
 */
export const idxWalletCallbackDeliveriesReceived = indexByName(
  INDEX_NAMES.idxWalletCallbackDeliveriesReceived,
);

/**
 * Serves `GET /v1/loyalty/terminals`: one tenant's tills, newest first.
 */
export const idxPosTerminalsBusiness = indexByName(INDEX_NAMES.idxPosTerminalsBusiness);
export const idxPushCampaignsBusiness = indexByName(INDEX_NAMES.idxPushCampaignsBusiness);
