-- 0133 — runner queues slice 3 WP5: worker groups / panels
-- (docs/runs-slice-3-plan.md §4 WP5). A group is a NAMED SET of worker
-- agents; a worker_invoke naming a group macro-expands at plan/append time
-- into par(one worker_invoke per member) + a panel audit in the enclosing
-- seq — the engine only ever sees shapes it already executes.
--
-- member_slugs are SOFT refs (the runs idiom): a deleted/disabled member is
-- caught by plan-time routing resolution with a teaching error, not by FK.

CREATE TABLE IF NOT EXISTS "agent_groups" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id"     uuid NOT NULL,
  "slug"         text NOT NULL,
  "name"         text NOT NULL,
  "member_slugs" text[] NOT NULL DEFAULT '{}',
  "enabled"      boolean NOT NULL DEFAULT true,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_groups_owner_slug_uq" ON "agent_groups" ("owner_id", "slug");
