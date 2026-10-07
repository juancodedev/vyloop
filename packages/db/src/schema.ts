import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  numeric,
  integer,
  boolean,
  date,
  unique,
  index,
  uniqueIndex,
  bigserial,
} from 'drizzle-orm/pg-core';

// ============================================================================
// Index declarations live here, inside each table's extra-config callback.
//
// WHY (this is the fix for a long-standing drift bug, and the reason is not
// obvious, so it is worth stating):
//
// drizzle-kit only sees an index if the index builder is *built against a
// table*, which is exactly what the extra-config callback does. Declaring an
// index as a standalone module-level export — e.g. `export const idxX =
// index('idx_x').on(...)` in a sibling `indexes.ts` — produces an
// `IndexBuilder` that no table ever claims. drizzle-kit drops those silently:
// it reports the tables with `0 indexes`, emits no `CREATE INDEX`, and reports
// "No schema changes, nothing to migrate". Nothing errors. The index simply
// never reaches a migration.
//
// Two fixes were available and both were measured against
// drizzle-kit 0.31.10 + drizzle-orm 0.45.2 (see packages/db/src/migration-sql.test.ts
// for the executable proof):
//
//   A. Add `./src/indexes.ts` to the `schema` array in drizzle.config.ts.
//      REJECTED — verified to be a no-op. drizzle-kit reads the extra file and
//      still reports `0 indexes`, for the reason above. It also silently
//      inflates the table count, which is a false signal that something was
//      picked up.
//
//   B. Declare every index in the table's extra-config callback. ACCEPTED.
//      drizzle-kit emits the expected `CREATE INDEX` / `CREATE UNIQUE INDEX`
//      statements, including `USING gin` and partial `WHERE` predicates, and
//      the index shows up in the snapshot so future generations diff against
//      it instead of re-deriving it.
//
// Index columns are still written as `sql` templates rather than bare column
// objects. That is deliberate: in drizzle-orm 0.45.2 `index().on(table.col)`
// throws `JSON.parse(undefined)` for a column that carries no index config,
// and the typed column accessors (`.asc()`, `.nullsLast()`) are not present on
// `PgColumn` in this version. `sql` is the only form that both compiles and
// survives drizzle-kit's introspector, including for `DESC NULLS LAST` and
// `USING gin`, which have no other spelling here.
//
// `indexes.ts` no longer declares anything. It re-derives the public index
// exports from the built table configs so there is exactly one source of truth
// and no second list to forget to update.
// ============================================================================

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
  passwordHash: text('password_hash'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  // Unique on `email` alone, not on `(business_id, email)`. The login route
  // resolves an operator by email with no tenant filter, so a tenant-scoped
  // constraint permitted the same address to administer two businesses and the
  // login then resolved whichever row came back first. One address is one
  // account, which is what a single `business_id` column already assumed.
  unique('uq_users_email').on(table.email),
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
  currentTierId: uuid('current_tier_id').references(() => membershipTiers.id),
  // Short, tenant-scoped, non-correlational code shown on the loyalty pass as
  // `accountId`. Nullable so existing customers are unaffected by the
  // migration; stored rather than derived on read so the algorithm can change
  // without invalidating a code a customer has already memorised.
  memberCode: text('member_code'),
  metadata: jsonb('metadata').default({}),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  unique('uq_customers_business_phone').on(table.businessId, table.phone),
  unique('uq_customers_business_email').on(table.businessId, table.email),

  // Partial index: quick phone lookup at the POS. Only rows where phone IS NOT
  // NULL are indexed, so the index stays proportional to the customers who can
  // actually be found by phone.
  index('idx_customers_phone')
    .on(sql`${table.businessId}`, sql`${table.phone}`)
    .where(sql`phone IS NOT NULL`),

  // Churn alerts. NULLS LAST so customers who have never visited appear at the
  // end of the list rather than the top.
  index('idx_customers_last_visit').on(
    sql`${table.businessId}`,
    sql`${table.lastVisitAt} DESC NULLS LAST`,
  ),

  // GIN on the JSONB metadata bag for dynamic attribute filtering and
  // segmentation.
  index('idx_customers_metadata').using('gin', sql`${table.metadata}`),

  // Partial unique index: tenant-scoped uniqueness of the loyalty-pass member
  // code.
  //
  // The index is **partial** (`WHERE member_code IS NOT NULL`) on purpose.
  //
  // Worth being precise about why, because the obvious justification is wrong:
  // Postgres treats NULLs as distinct in a unique index, so a plain unique index
  // on `(business_id, member_code)` would *not* have failed on the existing rows
  // that all share `member_code = NULL`. The real reasons to make it partial:
  //
  // 1. The constraint has no meaning for NULL. NULL means "this customer has no
  //    pass code yet", and two customers both having no code is not a collision.
  // 2. A non-partial index would carry an entry for every existing customer —
  //    the entire table — all of them useless, and every customer insert and
  //    update would pay to maintain it.
  // 3. It keeps the index proportional to the number of customers who actually
  //    hold a pass, which is what the issuance path needs to look up against.
  //
  // `business_id` is the tenant: the same person is a different customer at a
  // different merchant and must get a different code there.
  uniqueIndex('uq_customers_business_member_code')
    .on(sql`${table.businessId}`, sql`${table.memberCode}`)
    .where(sql`member_code IS NOT NULL`),
]);

export const customerEvents = pgTable('customer_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  branchId: uuid('branch_id').references(() => branches.id),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  // Customer360 queries: a customer's events, newest first.
  index('idx_customer_events_customer').on(
    sql`${table.businessId}`,
    sql`${table.customerId}`,
    sql`${table.createdAt} DESC`,
  ),
  // Analytical queries: scan events by type across customers, newest first.
  index('idx_customer_events_type').on(
    sql`${table.businessId}`,
    sql`${table.eventType}`,
    sql`${table.createdAt} DESC`,
  ),
]);

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

  // ---------------------------------------------------------------------------
  // The accumulation rule (§7.5 "Mecánica de acumulación")
  // ---------------------------------------------------------------------------
  //
  // `earnRate` alone cannot say what a customer earns: it is a rate, and a rate
  // is meaningless without the thing it is a rate *of*. Until this pair existed
  // the product's own dashboard told merchants "1 punto por cada $1.000" while
  // the earn route multiplied a caller-supplied point count by that number —
  // there was no money anywhere in the path. So the rule is now two columns
  // that have to agree, and `earnRate` means something different depending on
  // this one:
  //
  //   earn_by = 'visit'    → `earnRate` is points per qualifying visit/count,
  //                           and the caller supplies the count. "9 cafés y el
  //                           10 gratis" lives here.
  //   earn_by = 'purchase' → `earnRate` is points per `earnUnitAmount` pesos of
  //                           purchase, and the caller supplies the amount.
  //                           Points are derived here, never sent in.
  //
  // `visit` is the default because it is the mechanic the existing endpoint
  // already implements and the one a manual scanner honestly supports: with
  // only a scan, there is no amount. A default of `purchase` would have made
  // every existing caller's request start failing.
  earnBy: text('earn_by').notNull().default('visit'),

  // The money amount, in pesos, that one unit of `earnRate` is worth. Only read
  // when `earnBy = 'purchase'`.
  //
  // Defaults to 1.000 rather than 1 so that a program which flips to `purchase`
  // without touching the unit keeps paying what the merchant was already shown
  // on the config screen. Never NULL: `NULL` here would mean "the program earns
  // points from money but has not said how much money", which is a division by
  // zero at the moment of a sale rather than a configuration error at the moment
  // it was written.
  earnUnitAmount: numeric('earn_unit_amount', { precision: 12, scale: 2 }).notNull().default('1000.00'),
  minRedeemPoints: integer('min_redeem_points').notNull().default(100),
  pointsExpiryDays: integer('points_expiry_days'),
  // The merchant's own sentence about what the programme is for, shown on the
  // Google Wallet pass ("¡Cada 10 sellos, un burger gratis!"). Rendered as a
  // `textModulesData` entry on the loyalty *class*, not the object: it is the
  // same for every customer, and changing a promotion must be one class patch
  // rather than N object patches.
  //
  // Nullable, and read as "absent" rather than as an empty string. Every other
  // text in this table has a default, and copying that here would put a
  // merchant's card in front of a comensal reading a generic sentence nobody
  // wrote. Google documents a 500-character recommendation for
  // `TextModuleData.body`; the pass builder is where that limit is enforced, so
  // a value written here directly is caught at build time rather than at
  // Google's insert.
  //
  // Not derivable from `name`, `pointsCurrency`, `earnRate`, `minRedeemPoints`
  // or `pointsExpiryDays`: none of those says anything about what the member
  // gets for earning, which is the entire content of this field.
  promoCopy: text('promo_copy'),
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
}, (table) => [
  unique('uq_points_tx_reference').on(table.customerId, table.referenceId),

  // Current-balance lookups. `created_at DESC` so the most recent transaction
  // for a customer is the first row the planner reaches.
  index('idx_points_balance').on(
    sql`${table.businessId}`,
    sql`${table.customerId}`,
    sql`${table.createdAt} DESC`,
  ),
]);

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
// Communication Domain
// ============================================================================

export const messageLog = pgTable('message_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  direction: text('direction').notNull(),
  channel: text('channel').notNull().default('whatsapp'),
  status: text('status').notNull().default('queued'),
  providerMessageId: text('provider_message_id'),
  content: jsonb('content').default({}),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  // A customer's message history, newest first.
  index('idx_message_log_customer').on(
    sql`${table.businessId}`,
    sql`${table.customerId}`,
    sql`${table.createdAt} DESC`,
  ),
  // Delivery-dashboard filtering by status, newest first.
  index('idx_message_log_status').on(
    sql`${table.businessId}`,
    sql`${table.status}`,
    sql`${table.createdAt} DESC`,
  ),
]);

export const whatsappTemplates = pgTable('whatsapp_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  language: text('language').notNull(),
  category: text('category').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('pending'),
  metaTemplateId: text('meta_template_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  // Resolve a template by business and name when rendering a campaign.
  index('idx_whatsapp_templates_name').on(sql`${table.businessId}`, sql`${table.name}`),
]);

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
// Rewards Domain
// ============================================================================

export const rewards = pgTable('rewards', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  pointsCost: integer('points_cost').notNull(),
  category: text('category'),
  stock: integer('stock'),
  autoGrantThreshold: integer('auto_grant_threshold'),
  validFrom: timestamp('valid_from', { withTimezone: true }),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  imageUrl: text('image_url'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  unique('uq_rewards_business_name').on(table.businessId, table.name),

  // Catalog browsing: filter the reward catalog by category per business.
  index('idx_rewards_category').on(sql`${table.businessId}`, sql`${table.category}`),

  // Partial: only rewards that actually have an auto-grant threshold can ever
  // be auto-granted, so the rest are left out of the index entirely.
  index('idx_rewards_auto_grant')
    .on(sql`${table.businessId}`, sql`${table.autoGrantThreshold}`)
    .where(sql`auto_grant_threshold IS NOT NULL`),
]);

export const rewardGrants = pgTable('reward_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  rewardId: uuid('reward_id').notNull().references(() => rewards.id, { onDelete: 'cascade' }),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().default(sql`now()`),
  balanceAfter: integer('balance_after'),
}, (table) => [
  unique('uq_reward_grants_customer_reward').on(table.customerId, table.rewardId),

  // Fast idempotency check for reward grants: "has this customer already been
  // granted this reward?" is asked on every redemption attempt.
  index('idx_reward_grants_customer').on(sql`${table.customerId}`, sql`${table.rewardId}`),
]);

// ============================================================================
// Wallet Domain
//
// Tracking state only. The balance and the program stay where they are
// (`points_transactions`, `loyalty_programs`, `membership_tiers`) so there is
// one source of truth and the pass is a projection, not a second ledger.
// ============================================================================

export const tenantWalletPrograms = pgTable('tenant_wallet_programs', {
  // `tenants.id` is the sole key: exactly one class per tenant. That is what
  // makes a merchant rebrand a single class patch that propagates to every
  // object referencing it.
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  // The Google-issued issuer id. Same for every tenant, stored per row so that
  // moving to a different issuer is a data change and not a code change.
  issuerId: text('issuer_id').notNull(),
  // The full `<issuerId>.tenant-<tenantId>`.
  classId: text('class_id').notNull(),
  // `none` | `draft` | `under_review` | `approved` | `rejected`. Google's enum
  // is `DRAFT` | `UNDER_REVIEW` | `APPROVED` | `REJECTED`; the snake_case here
  // is vyloop's own storage form and is translated in the payload builder.
    reviewStatus: text('review_status').notNull().default('none'),
    // Whether this tenant is still inside Google's demo mode, declared per
    // business rather than per deployment. `true` is the default and the safe
    // direction: while it holds, a `draft` class can be used to mint a pass
    // because Google itself limits delivery to the issuer's test accounts, and
    // the system says nothing about the pass working for the public.
    //
    // Flipping it to `false` is the operator declaring that Google granted
    // publishing access. It is the only thing that makes a `draft` class an
    // error instead of a test.
    //
    // `WALLET_DEMO_MODE` stays the deployment-wide ceiling, and the effective
    // value is `env || db`, so a deployment can refuse every mint regardless of
    // what any row says.
    demoMode: boolean('demo_mode').notNull().default(true),

    // Months of customer inactivity after which this tenant's Google Wallet
    // passes are deactivated automatically.
    //
    // ## `NULL` is the default *because there is no default*
    //
    // The column is nullable with **no** default value, and `NULL` means the
    // rule is off. That is the whole safety argument for this feature, so it is
    // worth being explicit about what the alternatives would have done. A
    // `DEFAULT 6` would put every existing tenant — and every tenant created by
    // the next migration — into a state where the first run of the rule moves
    // their customers' cards into the "Expired passes" section of real phones.
    // Nobody asked for that, and it cannot be undone from here: the only route
    // back is the customer re-adding the card. The rule is therefore opt-in, and
    // opt-in has to be spelled as "a human wrote a number" or it is not opt-in.
    //
    // The first run of an opted-in rule is still a mass state change, which is
    // why `workers/wallet/src/inactivity.ts` can decide without acting and
    // reports the count it would touch before anything is written.
    //
    // ## Why this is not `loyalty_programs.points_expiry_days`
    //
    // That column exists, is nullable, and is unread. It is a different rule
    // wearing a similar name, and reusing it would import its semantics silently:
    //
    //   - **Unit.** It is days. This window is calendar months. Months are
    //     relative to a date (`2026-03-31` minus one month is `2026-02-28`) and
    //     days are not, so a days column cannot express a months window without
    //     a lossy conversion or a unit lie in the column name.
    //   - **Activity.** Points expiry answers "how long do *points* survive".
    //     This rule answers "how long has this *customer* been away". Redemption
    //     is activity here (`points_transactions.points` is signed, so spending
    //     is a negative row) and is emphatically not a points-earning event; a
    //     column whose name is about points carries the assumption that it is
    //     about points going up.
    //   - **Effect.** Points expiry touches the ledger. This touches Google's
    //     object state and our tracking row.
    //   - **Who reads it.** `pointsExpiryDays` is deliberately not surfaced to
    //     the customer app (see `workers/customer/src/routes.ts`). A merchant
    //     who set it to 180 to mean "points die after half a year" would get
    //     their customers' *cards* muted instead, which is the exact
    //     mute-too-much incident this column's nullability exists to prevent.
    //
    // ## It lives here rather than on `loyalty_programs`
    //
    // This is a wallet behaviour switch, and `demo_mode` next to it is the
    // precedent: a per-tenant decision about what this worker is allowed to do
    // to a merchant's passes belongs with the merchant's wallet program row,
    // where the wallet worker already keeps the rest of that policy.
    //
    // A value of `0` or less is treated as "off" by the reader, because a
    // `NULL`-only guard would let a hand-edited `0` deactivate every pass in the
    // tenant on the next run.
    passInactivityMonths: integer('pass_inactivity_months'),

    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export const customerWalletPasses = pgTable('customer_wallet_passes', {
  customerId: uuid('customer_id')
    .primaryKey()
    .references(() => customers.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  // The full `<issuerId>.member-<globalId>`. Derived from `customers.global_id`
  // rather than `customers.id` so the pass id survives a restore or a clone
  // into another environment.
  objectId: text('object_id').notNull(),
  // `not_issued` | `not_saved` | `issued` | `inactive` | `expired` | `completed`.
  //
  // `not_issued` means a save link was issued and no Google object has been
  // observed. `not_saved` means Google was asked and has no object, so the
  // customer has not saved the pass yet. The two are distinct because the
  // first is a customer state and the second is a gap in our knowledge, and a
  // merchant reading the second as the first is told a customer has no pass when
  // we had simply never checked. See `workers/wallet/src/reconcile.ts`, the only
  // writer of `not_saved`.
  //
  // `text` with no `check` constraint, on purpose, for the same reason
  // `tenant_wallet_programs.review_status` is: readers must fail closed on an
  // unrecognised value rather than the database refusing to store one. Adding a
  // state is therefore a code change, not a migration.
  state: text('state').notNull().default('not_issued'),
  // When we last got a definitive answer from Google about this object, whichever
  // way it went. A stale value is therefore "unverified since", not "unchanged
  // since", which is what makes a months-old row visibly untrustworthy without a
  // second column.
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  unique('uq_customer_wallet_passes_tenant_object').on(table.tenantId, table.objectId),

  // Find a customer's pass by tenant, for tenant-scoped pass listings and for
  // the cross-environment `objectId` lookup.
  index('idx_customer_wallet_passes_tenant').on(sql`${table.tenantId}`),
]);

/**
 * One row per Google Wallet callback delivery this system has already applied.
 *
 * ## Why the delivery needs a row of its own
 *
 * Google states that callbacks are best-effort, retried with backoff, and that
 * *"there might be duplicate deliveries"*, recommending the `nonce` be used to
 * deduplicate. Every other trigger in this worker is idempotent **by state** — a
 * second balance reconcile that finds the same number writes nothing — but a
 * callback cannot lean on that, because its two events move a pass in *opposite*
 * directions:
 *
 * ```text
 * not_saved --save--> issued --del--> not_saved
 * ```
 *
 * A replayed `save` arriving after a real `del` would move the row back to
 * `issued` and tell a merchant a customer is holding a pass they deleted. State
 * idempotency cannot catch that, because the two deliveries are genuinely
 * different events. Only the `nonce` distinguishes a retry from a fresh event.
 *
 * ## Why this is not a column on `customer_wallet_passes`
 *
 * It cannot be: one pass receives many callbacks over its life, so a single
 * "last nonce" column would let the *second* delivery of a pair replay. This is
 * a log, not a marker.
 *
 * ## The unique index is the whole mechanism
 *
 * `claimCallbackNonce` is `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so
 * "seen this nonce" and "record it" are one atomic statement. A read-then-write
 * would let two concurrent deliveries of the same nonce both observe absence and
 * both apply — and Google's retries are concurrent by nature.
 */
export const walletCallbackDeliveries = pgTable(
  'wallet_callback_deliveries',
  {
    /**
     * The surrogate key.
     *
     * A `bigserial` rather than a uuid because nothing ever looks a delivery up
     * by it: the only access is the uniqueness check on `(tenant_id, nonce)`. A
     * monotonic key keeps the index insert sequential instead of random.
     */
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /**
     * Google's `nonce`, verbatim.
     *
     * Stored as sent and compared exactly — no normalisation, no lowercasing. A
     * nonce this system does not recognise verbatim is a nonce it has not seen,
     * and rewriting it before comparison would let a distinct delivery collide
     * with a recorded one.
     */
    nonce: text('nonce').notNull(),
    /** Google's `eventType`, kept for support. Never used to decide anything. */
    eventType: text('event_type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    /**
     * The deduplication guarantee, enforced by the database rather than by the
     * application.
     *
     * Scoped per tenant rather than globally, because the class that produced
     * the delivery belongs to exactly one tenant: two tenants' callbacks arriving
     * in the same second are two events, and a global unique index would let one
     * merchant's customer suppress another's.
     */
    unique('uq_wallet_callback_deliveries_tenant_nonce').on(table.tenantId, table.nonce),

    // Pruning reads the oldest rows in insertion order, which is the table's
    // primary-key order and so needs no sort.
    index('idx_wallet_callback_deliveries_received').on(sql`${table.receivedAt}`),
  ],
);

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

export type MessageLog = typeof messageLog.$inferSelect;
export type NewMessageLog = typeof messageLog.$inferInsert;

export type WhatsAppTemplate = typeof whatsappTemplates.$inferSelect;
export type NewWhatsAppTemplate = typeof whatsappTemplates.$inferInsert;

export type Reward = typeof rewards.$inferSelect;
export type NewReward = typeof rewards.$inferInsert;

export type RewardGrant = typeof rewardGrants.$inferSelect;
export type NewRewardGrant = typeof rewardGrants.$inferInsert;

export type TenantWalletProgram = typeof tenantWalletPrograms.$inferSelect;
export type NewTenantWalletProgram = typeof tenantWalletPrograms.$inferInsert;

export type CustomerWalletPass = typeof customerWalletPasses.$inferSelect;
export type NewCustomerWalletPass = typeof customerWalletPasses.$inferInsert;
