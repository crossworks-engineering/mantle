-- Unified maintenance run history — one row per invocation of a registry
-- task (docs/maintenance-runner.md), whatever surface started it:
--   source 'cli'  → pnpm maintain (best-effort: skipped when no DATABASE_URL)
--   source 'ui'   → the /debug/integrity Maintenance tab
--   source 'cron' → the nightly sweep tick in the events worker
--
-- The cron scheduler ALSO reads this table as its double-fire guard: a
-- schedulable task is due only when it has no 'cron' row (any terminal state
-- — a failed attempt still arms the guard, mirroring the backups scheduler)
-- newer than ~20h. Pure bookkeeping: no FK to nodes, no owner column
-- (single-owner system; runs are system-level, like pgboss jobs).
--
-- No CASCADE concerns — nothing references this table and it references
-- nothing. Rows are small; no reaper needed at current volumes.

CREATE TABLE IF NOT EXISTS "maintenance_runs" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug"        text NOT NULL,
  "source"      text NOT NULL CHECK ("source" IN ('cli', 'ui', 'cron')),
  "live"        boolean NOT NULL,
  "state"       text NOT NULL DEFAULT 'running' CHECK ("state" IN ('running', 'done', 'failed', 'cancelled')),
  "started_at"  timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "exit_code"   integer,
  "summary"     text
);--> statement-breakpoint

-- The cron due-check (latest cron row per slug) and the history list (recent
-- runs, newest first) both walk started_at descending.
CREATE INDEX IF NOT EXISTS "maintenance_runs_slug_started_idx"
  ON "maintenance_runs" ("slug", "started_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "maintenance_runs_started_idx"
  ON "maintenance_runs" ("started_at" DESC);
