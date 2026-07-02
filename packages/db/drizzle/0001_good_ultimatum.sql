ALTER TABLE "customers" ADD COLUMN "current_tier_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_current_tier_id_membership_tiers_id_fk" FOREIGN KEY ("current_tier_id") REFERENCES "public"."membership_tiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_transactions" ADD CONSTRAINT "uq_points_tx_reference" UNIQUE("customer_id","reference_id");