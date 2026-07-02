import { sql } from 'drizzle-orm';
import { index } from 'drizzle-orm/pg-core';
import {
  customers,
  customerEvents,
  pointsTransactions,
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
 * Convenience array of all indexes for bulk creation / export.
 */
export const allIndexes = [
  idxCustomersPhone,
  idxCustomersLastVisit,
  idxPointsBalance,
  idxCustomersMetadata,
  idxCustomerEventsCustomer,
  idxCustomerEventsType,
];
