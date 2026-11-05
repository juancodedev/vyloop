-- Enable row-level security on the wallet tables (openspec tenant-isolation-rls 6.4).
--
-- ## What this does
--
-- The three `TENANT_ID_TABLES` of `packages/db/src/rls.ts` get RLS and the
-- `tenant_isolation` policy that `enableTenantRls()` and
-- `createTenantRlsPolicies()` generate: a row is visible, and may be written,
-- only when its `tenant_id` equals `app.current_tenant_id`, which
-- `withTenantTransaction` sets on the transaction.
--
-- `push_campaigns` is recorded here too. Production had RLS and this exact
-- policy on it before the rollout started, applied outside any migration, so no
-- migration produced that state and a database built from the migrations lacked
-- it. Its statements are the ones `enableRls()` and `createRlsPolicies()`
-- generate for a `BUSINESS_ID_TABLES` table.
--
-- ## Who it binds
--
-- Only roles without BYPASSRLS that do not own the tables: the workers'
-- `vyloop_app` role. The owner credential (migrations, operational scripts)
-- keeps reading everything, because FORCE ROW LEVEL SECURITY is not set.
--
-- `current_setting(...)` is called without its `missing_ok` argument on
-- purpose: a query on these tables outside `withTenantTransaction` fails with
-- "unrecognized configuration parameter" instead of returning no rows.
--
-- ## Applying it to production
--
-- The `push_campaigns` policy already exists there, so drop it in the same
-- transaction that runs this file. The table is never without its policy:
--
--   BEGIN;
--   DROP POLICY tenant_isolation ON "push_campaigns";
--   -- the statements below
--   COMMIT;
--
-- ## Rollback
--
--   DROP POLICY tenant_isolation ON "<table>";
--   ALTER TABLE "<table>" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_wallet_programs" ENABLE ROW LEVEL SECURITY; --> statement-breakpoint
ALTER TABLE "customer_wallet_passes" ENABLE ROW LEVEL SECURITY; --> statement-breakpoint
ALTER TABLE "wallet_callback_deliveries" ENABLE ROW LEVEL SECURITY; --> statement-breakpoint
ALTER TABLE "push_campaigns" ENABLE ROW LEVEL SECURITY; --> statement-breakpoint
CREATE POLICY tenant_isolation ON "tenant_wallet_programs" USING (tenant_id = current_setting('app.current_tenant_id')::UUID); --> statement-breakpoint
CREATE POLICY tenant_isolation ON "customer_wallet_passes" USING (tenant_id = current_setting('app.current_tenant_id')::UUID); --> statement-breakpoint
CREATE POLICY tenant_isolation ON "wallet_callback_deliveries" USING (tenant_id = current_setting('app.current_tenant_id')::UUID); --> statement-breakpoint
CREATE POLICY tenant_isolation ON "push_campaigns" USING (business_id = current_setting('app.current_business_id')::UUID);
