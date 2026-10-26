-- Wallet messages: a manual message an operator sends to the business's pass
-- holders, plus the per-object delivery ledger.
--
-- ## What this closes
--
-- Unit 3 of `openspec/changes/wallet-notifications`: the storage behind
-- `POST /v1/wallet/messages`. Nothing reads these tables yet — the send route
-- (Unit 4) and the dashboard (Unit 5) are built on top of them.
--
-- ## Two tables, not one
--
-- `wallet_messages` is one row per message composed by an operator. `wallet_message_deliveries`
-- is one row per (message, pass): the mode actually used (`notify` or `text`),
-- the delivery status, and when it landed. Splitting them keeps the message
-- immutable while the fan-out reports per object, and the composite primary key
-- makes a retried job a no-op.
--
-- ## Tenancy
--
-- Both tables carry `business_id` and are members of `BUSINESS_ID_TABLES`, so
-- they receive the same RLS policy as every other merchant-scoped table. The
-- deliveries table does not repeat `business_id` — it joins through `message_id`
-- to `wallet_messages`, and the policy on the parent is the one that matters.
--
-- ## Cascade
--
-- Deleting a message cascades to its deliveries. Deleting a tenant cascades
-- through `business_id` on `wallet_messages`, which in turn cascades to the
-- deliveries. No orphan ledger rows survive either event.
--
-- Applied in production by hand. Plain `CREATE TABLE` on empty tables, no
-- `CONCURRENTLY` needed.
CREATE TABLE "wallet_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"header" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "idx_wallet_messages_business" ON "wallet_messages" ("business_id", "created_at" DESC);

CREATE TABLE "wallet_message_deliveries" (
	"message_id" uuid NOT NULL REFERENCES "wallet_messages"("id") ON DELETE CASCADE,
	"object_id" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "wallet_message_deliveries_pkey" PRIMARY KEY ("message_id", "object_id")
);

CREATE INDEX "idx_wallet_message_deliveries_message" ON "wallet_message_deliveries" ("message_id");
