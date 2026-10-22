CREATE TABLE "push_campaigns" (
	"reference_id" text PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"url" text,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_type" text DEFAULT 'branch' NOT NULL,
	"audience_size" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_campaigns" ADD CONSTRAINT "push_campaigns_business_id_tenants_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_push_campaigns_business" ON "push_campaigns" USING btree ("business_id","created_at" DESC);
