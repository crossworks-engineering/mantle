-- Validate the level CHECKs added NOT VALID in 0159, each in this migration's
-- own transaction so the heavier scan never shares a lock with the column
-- adds (plan 11: long migrations as NOT VALID, then VALIDATE).
ALTER TABLE "public"."nodes" VALIDATE CONSTRAINT "nodes_audience_ck";
--> statement-breakpoint
ALTER TABLE "public"."nodes" VALIDATE CONSTRAINT "nodes_audience_kind_ck";
--> statement-breakpoint
ALTER TABLE "public"."agents" VALIDATE CONSTRAINT "agents_audience_ck";
--> statement-breakpoint
ALTER TABLE "public"."tool_groups" VALIDATE CONSTRAINT "tool_groups_audience_ck";
