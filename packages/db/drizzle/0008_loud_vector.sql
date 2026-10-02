-- Per-delivery record of applied Google Wallet pass callbacks.
--
-- Google documents callbacks as best-effort, retried with backoff, and warns that
-- "there might be duplicate deliveries", recommending the `nonce` be used to
-- deduplicate. The other triggers in the wallet worker are idempotent by state --
-- a repeat balance reconcile that finds the same number writes nothing -- but a
-- callback cannot be, because its two events move a pass in opposite directions
-- (`save` -> issued, `del` -> not_saved). A replayed `save` arriving after a real
-- `del` would otherwise move the row back to `issued` and report to a merchant
-- that a customer is holding a pass they deleted. Only the nonce tells a retry
-- from a fresh event.
--
-- It cannot be a column on `customer_wallet_passes`: one pass receives many
-- callbacks over its life, so a "last nonce" marker would let the second delivery
-- of a pair replay.
--
-- The unique index below is the whole mechanism. `claimCallbackNonce` is a single
-- `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so "have I seen this nonce" and
-- "record it" are one atomic statement; a read-then-write would let two concurrent
-- retries both observe absence and both apply. Scoped per tenant rather than
-- globally, so one merchant's customer cannot suppress another's.
--
-- `event_type` is kept for support only. It is never used to decide anything --
-- the decision happens before this row is written.
CREATE TABLE "wallet_callback_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_wallet_callback_deliveries_tenant_nonce" UNIQUE("tenant_id","nonce")
);
--> statement-breakpoint
ALTER TABLE "wallet_callback_deliveries" ADD CONSTRAINT "wallet_callback_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_wallet_callback_deliveries_received" ON "wallet_callback_deliveries" USING btree ("received_at");