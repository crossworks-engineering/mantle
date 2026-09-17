-- Curated model pools — authoring store for the /models curator. One row per
-- curated model per pool ('agents' or an ai_worker kind; embedding excluded).
-- `routes` holds every provider route to the model (OpenRouter vs direct slugs
-- differ); `pricing` is a curation-time snapshot so direct-provider brains can
-- still render the $100 cost comparison. Advisory data only — nothing in the
-- runtime dispatch reads this table.

CREATE TABLE IF NOT EXISTS "curated_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"pool" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"vendor" text,
	"routes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pricing" jsonb,
	"rating" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "curated_models_owner_pool_name_uq" ON "curated_models" ("owner_id","pool","name");
