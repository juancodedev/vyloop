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
CREATE TABLE "reward_branches" (
	"reward_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_branches_pkey" PRIMARY KEY("reward_id","branch_id")
);
--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "push_campaigns" ADD CONSTRAINT "push_campaigns_business_id_tenants_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_branches" ADD CONSTRAINT "reward_branches_reward_id_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."rewards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_branches" ADD CONSTRAINT "reward_branches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_branches" ADD CONSTRAINT "reward_branches_business_id_tenants_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_push_campaigns_business" ON "push_campaigns" USING btree ("business_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_reward_branches_branch" ON "reward_branches" USING btree ("business_id","branch_id");--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_customer_events_branch" ON "customer_events" USING btree ("business_id","branch_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_pos_terminals_business" ON "pos_terminals" USING btree ("business_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_push_subscriptions_last_seen" ON "push_subscriptions" USING btree ("last_seen_at");