-- Documentation collections: the opt-in unit for the `documentation` node type.
-- One row per collection of markdown docs synced from disk into the brain. The
-- `system` collection (the repo's own docs/) ships DISABLED — nothing indexes
-- until the owner flips it on at /settings/documentation. The docs-sync worker
-- only reconciles + watches ENABLED collections.
--
-- `brain_depth` controls how deep a collection goes into memory:
--   'retrieval' — L5 only (summary + embedding + heading-chunks); the Docs agent
--                 can find & cite, but no facts/entities/graph land in the
--                 personal profile. Default for system docs.
--   'full'      — the complete extractor pipeline (facts/entities/graph too).
--                 For user-authored doc collections later.

CREATE TABLE IF NOT EXISTS "doc_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"origin" text DEFAULT 'system' NOT NULL,
	"root_path" text,
	"brain_depth" text DEFAULT 'retrieval' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "doc_collections_owner_key_uq" ON "doc_collections" ("owner_id","key");
