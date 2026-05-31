-- 0062: backup chat route for agents + ai_workers.
--
-- Adds an optional second chat route (provider/model/api key) to both tables,
-- plus a backup_enabled flag. When the active (primary) route hits a route-DOWN
-- or 429 error the runtime fails over to this backup. Unlike embeddings, a chat
-- backup may be a DIFFERENT model — no vector-space lock — which is what lets a
-- local model run as primary with a cloud model as the safety net.
--
-- The primary columns (provider/model/api_key_id) stay "the active route"; the
-- "make backup primary" UI just swaps the two sets of values. Purely additive +
-- defaulted, so existing rows are unchanged (backup_enabled = false → no
-- failover, identical behaviour to before).

ALTER TABLE "agents" ADD COLUMN "backup_provider" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "backup_model" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "backup_api_key_id" uuid;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "backup_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_backup_api_key_id_api_keys_id_fk" FOREIGN KEY ("backup_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_workers" ADD COLUMN "backup_provider" text;
--> statement-breakpoint
ALTER TABLE "ai_workers" ADD COLUMN "backup_model" text;
--> statement-breakpoint
ALTER TABLE "ai_workers" ADD COLUMN "backup_api_key_id" uuid;
--> statement-breakpoint
ALTER TABLE "ai_workers" ADD COLUMN "backup_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_workers" ADD CONSTRAINT "ai_workers_backup_api_key_id_api_keys_id_fk" FOREIGN KEY ("backup_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;
