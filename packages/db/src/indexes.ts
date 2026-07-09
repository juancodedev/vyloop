import { sql } from 'drizzle-orm';
import { index } from 'drizzle-orm/pg-core';

import {
  customers,
  customerEvents,
  pointsTransactions,
  rewards,
  rewardGrants,
  messageLog,
  whatsappTemplates,
} from './schema';

/**
 * Partial index: quick phone lookup at the POS.
 * Only rows where phone IS NOT NULL are indexed.
 */
export const idxCustomersPhone = index('idx_customers_phone')
  .on(sql`${customers.businessId}`, sql`${customers.phone}`)
  .where(sql`phone IS NOT NULL`);

/**
 * Index: find inactive customers for churn alerts.
 * Orders by last_visit_at DESC with NULLS LAST so customers who have
 * never visited appear at the end.
 */
export const idxCustomersLastVisit = index('idx_customers_last_visit')
  .on(sql`${customers.businessId}`, sql`${customers.lastVisitAt} DESC NULLS LAST`);

/**
 * Index: fast current-balance queries.
 * Uses created_at DESC so the most recent transaction (current balance)
 * is found quickly per customer.
 */
export const idxPointsBalance = index('idx_points_balance')
  .on(sql`${pointsTransactions.businessId}`, sql`${pointsTransactions.customerId}`, sql`${pointsTransactions.createdAt} DESC`);

/**
 * GIN index on JSONB metadata for dynamic attribute filtering/segmentation.
 */
export const idxCustomersMetadata = index('idx_customers_metadata')
  .using('gin', sql`${customers.metadata}`);

/**
 * Index for Customer360 queries: list events for a specific customer,
 * newest first.
 */
export const idxCustomerEventsCustomer = index('idx_customer_events_customer')
  .on(sql`${customerEvents.businessId}`, sql`${customerEvents.customerId}`, sql`${customerEvents.createdAt} DESC`);

/**
 * Index for analytical queries: scan events by type across customers,
 * newest first.
 */
export const idxCustomerEventsType = index('idx_customer_events_type')
  .on(sql`${customerEvents.businessId}`, sql`${customerEvents.eventType}`, sql`${customerEvents.createdAt} DESC`);

/**
 * Index: filter rewards by category per business (catalog browsing).
 */
export const idxRewardsCategory = index('idx_rewards_category')
  .on(sql`${rewards.businessId}`, sql`${rewards.category}`);

/**
 * Partial index: find auto-grant rewards by threshold per business.
 * Only rows with auto_grant_threshold IS NOT NULL are indexed.
 */
export const idxRewardsAutoGrant = index('idx_rewards_auto_grant')
  .on(sql`${rewards.businessId}`, sql`${rewards.autoGrantThreshold}`)
  .where(sql`auto_grant_threshold IS NOT NULL`);

/**
 * Index: fast idempotency check for reward grants per customer.
 */
export const idxRewardGrantsCustomer = index('idx_reward_grants_customer')
  .on(sql`${rewardGrants.customerId}`, sql`${rewardGrants.rewardId}`);

/**
 * Index: find message_log entries per customer, newest first.
 */
export const idxMessageLogCustomer = index('idx_message_log_customer')
  .on(sql`${messageLog.businessId}`, sql`${messageLog.customerId}`, sql`${messageLog.createdAt} DESC`);

/**
 * Index: filter message_log entries by status, newest first.
 */
export const idxMessageLogStatus = index('idx_message_log_status')
  .on(sql`${messageLog.businessId}`, sql`${messageLog.status}`, sql`${messageLog.createdAt} DESC`);

/**
 * Index: look up WhatsApp templates by business and name.
 */
export const idxWhatsappTemplatesName = index('idx_whatsapp_templates_name')
  .on(sql`${whatsappTemplates.businessId}`, sql`${whatsappTemplates.name}`);

/**
 * Convenience array of all indexes for bulk creation / export.
 */
export const allIndexes = [
  idxCustomersPhone,
  idxCustomersLastVisit,
  idxPointsBalance,
  idxCustomersMetadata,
  idxCustomerEventsCustomer,
  idxCustomerEventsType,
  idxRewardsCategory,
  idxRewardsAutoGrant,
  idxRewardGrantsCustomer,
  idxMessageLogCustomer,
  idxMessageLogStatus,
  idxWhatsappTemplatesName,
];
