-- Separate the scannable credential from the customer's identity.
--
-- ## What this closes
--
-- Points 2 and 3 of `docs/21-Hardening-Tarjetas-Wallet.md`. The Wallet barcode
-- and the customer-web QR both carried `customers.global_id`, an identifier that
-- can never change. A leaked screenshot of a pass was a credential nobody could
-- revoke.
--
-- ## Shape
--
-- The credential is a token the wallet worker derives from a secret, the
-- tenant, the customer's `global_id` and `card_token_version`. Only the version
-- and the token's SHA-256 are stored, never the token itself: rotating is bumping
-- the version, which changes the hash, and the old token stops matching.
--
-- Both columns are nullable with no default. NULL means "this customer has no
-- token yet", and such a customer's QR is still the uuid. A default would hand
-- every existing customer a token their Google object does not carry.
--
-- `customer_credential_revocations` is the audit trail of a rotation: who did it,
-- when, and why. It is scoped by `business_id` like every other tenant table and
-- receives its policy from `BUSINESS_ID_TABLES`, not from this file.
--
-- Applied in production by hand. `ADD COLUMN ... NULL` takes no lock on existing
-- rows, and the partial index only covers rows that have a token, which is none
-- at the moment this runs.
ALTER TABLE "customers" ADD COLUMN "card_token_version" integer;

ALTER TABLE "customers" ADD COLUMN "card_token_hash" text;

CREATE UNIQUE INDEX "uq_customers_business_card_token_hash" ON "customers" ("business_id", "card_token_hash") WHERE card_token_hash IS NOT NULL;

CREATE TABLE "customer_credential_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
	"actor_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"previous_version" integer,
	"new_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "idx_customer_credential_revocations_customer" ON "customer_credential_revocations" ("business_id", "customer_id", "created_at" DESC);
