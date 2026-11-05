-- Enable row-level security on the communication batch (openspec tenant-isolation-rls 7.1).
--
-- `message_log`, `whatsapp_templates` and `push_subscriptions` get RLS and the
-- `tenant_isolation` policy that `enableRls()` and `createRlsPolicies()`
-- generate for a `BUSINESS_ID_TABLES` table: a row is visible, and may be
-- written, only when its `business_id` equals `app.current_business_id`, which
-- `withTenantTransaction` sets on the transaction. It binds the workers'
-- `vyloop_app` role only; the owner keeps reading everything (no FORCE).
--
-- Every runtime access to these tables runs inside `withTenantTransaction`,
-- with one exception: the Meta WhatsApp webhook (`workers/communication/src/routes.ts`,
-- `POST /webhook`) looks up `message_log` by `provider_message_id` and
-- `customers` by phone without a tenant. WhatsApp is not in use, so that route
-- receives no traffic; under this policy its status-callback update fails
-- instead of reaching another tenant's row.
--
-- ## Rollback
--
--   DROP POLICY tenant_isolation ON "<table>";
--   ALTER TABLE "<table>" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "message_log" ENABLE ROW LEVEL SECURITY; --> statement-breakpoint
ALTER TABLE "whatsapp_templates" ENABLE ROW LEVEL SECURITY; --> statement-breakpoint
ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY; --> statement-breakpoint
CREATE POLICY tenant_isolation ON "message_log" USING (business_id = current_setting('app.current_business_id')::UUID); --> statement-breakpoint
CREATE POLICY tenant_isolation ON "whatsapp_templates" USING (business_id = current_setting('app.current_business_id')::UUID); --> statement-breakpoint
CREATE POLICY tenant_isolation ON "push_subscriptions" USING (business_id = current_setting('app.current_business_id')::UUID);
