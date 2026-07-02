import { pgTable, uuid, text, timestamp, jsonb, numeric, integer, boolean, date, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ============================================================================
// Identity Domain
// ============================================================================

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().default('free'),
  status: text('status').notNull().default('active'),
  baseCurrency: text('base_currency').notNull().default('CLP'),
  timezone: text('timezone').notNull().default('America/Santiago'),
  country: text('country').notNull().default('CL'),
  language: text('language').notNull().default('es-CL'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export const branches = pgTable('branches', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  address: text('address'),
  city: text('city'),
  country: text('country').notNull(),
  timezone: text('timezone'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  fullName: text('full_name'),
  role: text('role').notNull().default('cashier'),
  branchId: uuid('branch_id').references(() => branches.id),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  unique('uq_users_business_email').on(table.businessId, table.email),
]);

// ============================================================================
// Customer Domain
// ============================================================================

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  globalId: uuid('global_id').notNull().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  phone: text('phone'),
  email: text('email'),
  fullName: text('full_name'),
  birthDate: date('birth_date'),
  identityDoc: text('identity_doc'),
  identityType: text('identity_type'),
  language: text('language').default('es'),
  optedInAt: timestamp('opted_in_at', { withTimezone: true }),
  lastVisitAt: timestamp('last_visit_at', { withTimezone: true }),
  metadata: jsonb('metadata').default({}),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  unique('uq_customers_business_phone').on(table.businessId, table.phone),
  unique('uq_customers_business_email').on(table.businessId, table.email),
]);

export const customerEvents = pgTable('customer_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  branchId: uuid('branch_id').references(() => branches.id),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export const consents = pgTable('consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  consentType: text('consent_type').notNull(),
  granted: boolean('granted').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ipAddress: text('ip_address'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
});

// ============================================================================
// Growth Domain
// ============================================================================

export const loyaltyPrograms = pgTable('loyalty_programs', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().unique().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull().default('Programa de beneficios'),
  pointsCurrency: text('points_currency').notNull().default('puntos'),
  earnRate: numeric('earn_rate', { precision: 10, scale: 4 }).notNull().default('1.0'),
  minRedeemPoints: integer('min_redeem_points').notNull().default(100),
  pointsExpiryDays: integer('points_expiry_days'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export const membershipTiers = pgTable('membership_tiers', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  programId: uuid('program_id').notNull().references(() => loyaltyPrograms.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  minPoints: integer('min_points').notNull().default(0),
  multiplier: numeric('multiplier', { precision: 4, scale: 2 }).notNull().default('1.0'),
  benefits: jsonb('benefits').default('[]'),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export const pointsTransactions = pgTable('points_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  branchId: uuid('branch_id').references(() => branches.id),
  type: text('type').notNull(),
  points: integer('points').notNull(),
  balanceAfter: integer('balance_after').notNull(),
  referenceId: text('reference_id'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export const crossLoyaltyAlliances = pgTable('cross_loyalty_alliances', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantAId: uuid('tenant_a_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  tenantBId: uuid('tenant_b_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  earnRateAb: numeric('earn_rate_ab', { precision: 4, scale: 2 }).notNull().default('0.5'),
  earnRateBa: numeric('earn_rate_ba', { precision: 4, scale: 2 }).notNull().default('0.5'),
  status: text('status').notNull().default('pending'),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  unique('uq_alliance_pair').on(table.tenantAId, table.tenantBId),
]);

export const referrals = pgTable('referrals', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  referrerId: uuid('referrer_id').notNull().references(() => customers.id),
  referredId: uuid('referred_id').notNull().references(() => customers.id),
  pointsAwarded: integer('points_awarded').notNull().default(0),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
});

// ============================================================================
// Automation Domain
// ============================================================================

export const workflows = pgTable('workflows', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  triggerEvent: text('trigger_event').notNull(),
  conditions: jsonb('conditions').default('[]'),
  actions: jsonb('actions').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export const workflowExecutions = pgTable('workflow_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  workflowId: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').references(() => customers.id),
  status: text('status').notNull(),
  error: text('error'),
  executedAt: timestamp('executed_at', { withTimezone: true }).notNull().default(sql`now()`),
});

// ============================================================================
// AI Domain
// ============================================================================

export const churnPredictions = pgTable('churn_predictions', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  score: numeric('score', { precision: 5, scale: 4 }).notNull(),
  riskLevel: text('risk_level').notNull(),
  rfmRecency: integer('rfm_recency'),
  rfmFrequency: integer('rfm_frequency'),
  rfmMonetary: numeric('rfm_monetary', { precision: 12, scale: 2 }),
  modelVersion: text('model_version').notNull().default('rfm-v1'),
  calculatedAt: timestamp('calculated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  unique('uq_churn_business_customer').on(table.businessId, table.customerId),
]);

// ============================================================================
// Compliance Domain
// ============================================================================

export const localizationConfigs = pgTable('localization_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().unique().references(() => tenants.id, { onDelete: 'cascade' }),
  country: text('country').notNull(),
  language: text('language').notNull(),
  currency: text('currency').notNull(),
  idFormat: text('id_format').notNull(),
  privacyLaw: text('privacy_law').notNull(),
  dataRetentionDays: integer('data_retention_days').default(1825),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});

// ============================================================================
// Type Exports
// ============================================================================

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

export type CustomerEvent = typeof customerEvents.$inferSelect;
export type NewCustomerEvent = typeof customerEvents.$inferInsert;

export type Consent = typeof consents.$inferSelect;
export type NewConsent = typeof consents.$inferInsert;

export type LoyaltyProgram = typeof loyaltyPrograms.$inferSelect;
export type NewLoyaltyProgram = typeof loyaltyPrograms.$inferInsert;

export type MembershipTier = typeof membershipTiers.$inferSelect;
export type NewMembershipTier = typeof membershipTiers.$inferInsert;

export type PointsTransaction = typeof pointsTransactions.$inferSelect;
export type NewPointsTransaction = typeof pointsTransactions.$inferInsert;

export type CrossLoyaltyAlliance = typeof crossLoyaltyAlliances.$inferSelect;
export type NewCrossLoyaltyAlliance = typeof crossLoyaltyAlliances.$inferInsert;

export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;

export type WorkflowExecution = typeof workflowExecutions.$inferSelect;
export type NewWorkflowExecution = typeof workflowExecutions.$inferInsert;

export type ChurnPrediction = typeof churnPredictions.$inferSelect;
export type NewChurnPrediction = typeof churnPredictions.$inferInsert;

export type LocalizationConfig = typeof localizationConfigs.$inferSelect;
export type NewLocalizationConfig = typeof localizationConfigs.$inferInsert;
