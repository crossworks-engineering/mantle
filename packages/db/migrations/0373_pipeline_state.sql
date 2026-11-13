-- Pipelines phase 2 (docs/pipelines-options.md): the state of a pipeline on
-- this box. The registry stays code (BUILTIN_PIPELINES,
-- packages/files/src/pipelines/builtin.ts). This table holds only what a box
-- changed: no row means the defaults of the code (defaultState), so a box
-- that never opens the Pipelines screen behaves as before.
--
-- pipeline_state, one row per pipeline a box changed:
--  - enabled: on or off. NULL is the default of the code.
--  - position: NULL is the order of the code. No write in phase 2: each file
--    type has one reader, so there is nothing to rank.
--  - options: what an Admin set, checked by checkOptions before every write.
--    Read only through effectiveOptions, so a value that no longer passes
--    gives the default.
--  - workspaces: the attach list of an `after` pipeline. NULL is the default
--    of the code. A list, not workspace_resources rows: a built-in's id is in
--    the code, so SQL cannot check it, and a pipeline writes only into the
--    file's own database (configuration, not a rights border).
--  - updated_by: the login that last set it.
-- Written by an Admin user (the settings area: PATCH /api/pipelines/:id and
-- pipeline_set), read on the system pool by pipelineStateOf
-- (packages/content/src/pipeline-state.ts), its one reader and writer.
--
-- No grant to the workspace role (access matrix: none): only the system
-- pool reads it. Grants come from the access matrix (applyViewerGrants),
-- never from here. No seed row, no trigger: nothing here starts any work.
-- Additive, no rewrite, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0373_pipeline_state.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."pipeline_state" (
  "owner_id" uuid NOT NULL,
  "pipeline_id" text NOT NULL,
  "enabled" boolean,
  "position" integer,
  "options" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "workspaces" uuid[],
  "updated_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("owner_id", "pipeline_id"),
  CONSTRAINT "pipeline_state_id_ck" CHECK ("pipeline_id" ~ '^[a-z0-9][a-z0-9-]{0,39}$')
);
