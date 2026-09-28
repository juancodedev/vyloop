-- Google Wallet loyalty pass tracking, plus the pre-existing schema backlog.
--
-- Everything below is drizzle-kit's own output for this single diff. It is not
-- hand-edited, and `src/migration-sql.test.ts` fails if it ever stops parsing
-- or stops containing the objects listed here.
--
-- This migration closes three distinct gaps that had accumulated independently:
--
-- 1. WALLET (new feature). Two tracking tables, `tenant_wallet_programs` and
--    `customer_wallet_passes`, plus `customers.member_code`. The balance and the
--    program stay where they are (`points_transactions`, `loyalty_programs`,
--    `membership_tiers`): the pass is a projection, not a second ledger.
--
-- 2. TWO MISSING TABLES. `message_log` and `whatsapp_templates` are declared in
--    `src/schema.ts` and have been read and written by the communication worker
--    since before this migration, but they appear in no earlier migration and
--    no earlier snapshot. They do not exist in the live database. An earlier
--    hand-edit of this file deleted these two CREATE TABLE statements on the
--    theory that the tables "already existed" and the statements would fail;
--    they do not exist, so that edit would have left the application querying
--    tables that were never created. Restored here.
--
-- 3. THIRTEEN MISSING INDEXES. Every index in this package had been declared in
--    `src/indexes.ts` as a module-level export, which drizzle-kit does not
--    associate with a table and therefore never emitted. No `CREATE INDEX` had
--    ever reached a migration in this repository. The declarations now live in
--    each table's extra-config callback in `src/schema.ts`, which is the form
--    drizzle-kit can see; see the comment at the top of that file.
--
-- ORDER. drizzle-kit emitted the statements in dependency order, and that order
-- is load-bearing:
--
--   - every CREATE TABLE precedes every CREATE INDEX, so the two restored tables
--     exist before `idx_message_log_*` and `idx_whatsapp_templates_name` target
--     them;
--   - `ALTER TABLE "customers" ADD COLUMN "member_code"` precedes
--     `uq_customers_business_member_code`, which indexes that column;
--   - the ALTER TABLE ... ADD CONSTRAINT foreign keys follow the CREATE TABLE
--     statements for the same reason.
--
-- This migration does NOT enable row-level security anywhere. The RLS helpers in
-- `src/rls.ts` are not applied by any migration, by design; see the rollout note
-- in the pull request before enabling anything.

CREATE TABLE "customer_wallet_passes" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" text NOT NULL,
	"state" text DEFAULT 'not_issued' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_customer_wallet_passes_tenant_object" UNIQUE("tenant_id","object_id")
);
--> statement-breakpoint
CREATE TABLE "message_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"content" jsonb DEFAULT '{}'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_wallet_programs" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"issuer_id" text NOT NULL,
	"class_id" text NOT NULL,
	"review_status" text DEFAULT 'none' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"meta_template_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "member_code" text;--> statement-breakpoint
ALTER TABLE "customer_wallet_passes" ADD CONSTRAINT "customer_wallet_passes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_wallet_passes" ADD CONSTRAINT "customer_wallet_passes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_log" ADD CONSTRAINT "message_log_business_id_tenants_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_log" ADD CONSTRAINT "message_log_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_wallet_programs" ADD CONSTRAINT "tenant_wallet_programs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_business_id_tenants_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_customer_wallet_passes_tenant" ON "customer_wallet_passes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_message_log_customer" ON "message_log" USING btree ("business_id","customer_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_message_log_status" ON "message_log" USING btree ("business_id","status","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_whatsapp_templates_name" ON "whatsapp_templates" USING btree ("business_id","name");--> statement-breakpoint
CREATE INDEX "idx_customer_events_customer" ON "customer_events" USING btree ("business_id","customer_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_customer_events_type" ON "customer_events" USING btree ("business_id","event_type","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_customers_phone" ON "customers" USING btree ("business_id","phone") WHERE phone IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_customers_last_visit" ON "customers" USING btree ("business_id","last_visit_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_customers_metadata" ON "customers" USING gin ("metadata");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_customers_business_member_code" ON "customers" USING btree ("business_id","member_code") WHERE member_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_points_balance" ON "points_transactions" USING btree ("business_id","customer_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_reward_grants_customer" ON "reward_grants" USING btree ("customer_id","reward_id");--> statement-breakpoint
CREATE INDEX "idx_rewards_category" ON "rewards" USING btree ("business_id","category");--> statement-breakpoint
CREATE INDEX "idx_rewards_auto_grant" ON "rewards" USING btree ("business_id","auto_grant_threshold") WHERE auto_grant_threshold IS NOT NULL;