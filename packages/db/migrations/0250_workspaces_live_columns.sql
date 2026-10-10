-- Workspaces, phase W4a, part 1: the columns (plan R3; the W4a audit, finding
-- 3). Its own migration so the brief ACCESS EXCLUSIVE locks of the column
-- adds on seven chat and run tables end at its commit, before 0251's long
-- grant pass. The foreign keys are NOT VALID: existing rows are all NULL or
-- backfilled by 0251 from workspace ids; a later release validates them
-- (VALIDATE CONSTRAINT does not block writes).
--
-- R3 rows (threads, messages, tool results, runs, pending calls, traces)
-- carry the workspace and the login they belong to, stamped at insert: the
-- workspace from the agent (or the run, or the trace), the login from the
-- writer, else the trace's data.login_id, else the transaction's
-- mantle.login_id. Until the read rules land (W4b): a row with NULL
-- workspace is the Admin workspace's, and a row of another workspace with
-- NULL login is readable in the Admin workspace only (never by every user
-- of that workspace).
--
-- No trigger here starts LLM work and nothing notifies the extractor.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "public"."item_grants"
  ADD COLUMN IF NOT EXISTS "bridge" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Which of the brain's workspaces the bridges keep ('admin', 'team').
ALTER TABLE "public"."workspaces"
  ADD COLUMN IF NOT EXISTS "bridge_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_bridge_key_uq"
  ON "public"."workspaces" ("owner_id", "bridge_key") WHERE "bridge_key" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."assistant_messages"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid,
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."chat_threads"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid,
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."tool_results"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid,
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."runs"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid,
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."run_items"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid,
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."pending_tool_calls"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid,
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."traces"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid,
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistant_messages', 'chat_threads', 'tool_results', 'runs',
                           'run_items', 'pending_tool_calls', 'traces'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_workspace_id_fk') THEN
      EXECUTE format('ALTER TABLE "public".%I ADD CONSTRAINT %I FOREIGN KEY ("workspace_id") '
                     'REFERENCES "public"."workspaces"("id") ON DELETE NO ACTION NOT VALID',
                     t, t || '_workspace_id_fk');
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint

-- ── R3: stamp the workspace and the login at insert ─────────────────────────
-- A lookup by primary key per row: no LLM work, no notify.
CREATE OR REPLACE FUNCTION "public"."mantle_stamp_workspace_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  src record;
  d text;
BEGIN
  IF TG_TABLE_NAME = 'run_items' THEN
    SELECT r."workspace_id" AS ws, r."login_id" AS login INTO src
      FROM "public"."runs" r WHERE r."id" = NEW."run_id";
  ELSIF TG_TABLE_NAME IN ('tool_results', 'pending_tool_calls') THEN
    SELECT t."workspace_id" AS ws, t."login_id" AS login INTO src
      FROM "public"."traces" t WHERE t."id" = NEW."trace_id";
    IF NOT FOUND AND TG_TABLE_NAME = 'pending_tool_calls' THEN
      SELECT a."workspace_id" AS ws, NULL::uuid AS login INTO src
        FROM "public"."agents" a WHERE a."id" = NEW."agent_id";
    END IF;
  ELSE
    SELECT a."workspace_id" AS ws, NULL::uuid AS login INTO src
      FROM "public"."agents" a WHERE a."id" = NEW."agent_id";
  END IF;
  IF FOUND THEN
    NEW."workspace_id" := coalesce(NEW."workspace_id", src.ws);
    NEW."login_id" := coalesce(NEW."login_id", src.login);
  END IF;
  -- A trace names the login it served in its data (team turns do).
  IF TG_TABLE_NAME = 'traces' AND NEW."login_id" IS NULL THEN
    d := NEW."data"->>'login_id';
    IF d ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      NEW."login_id" := d::uuid;
    END IF;
  END IF;
  NEW."login_id" := coalesce(NEW."login_id", "public"."mantle_login_id"());
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_stamp_workspace_trg"() FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistant_messages', 'chat_threads', 'tool_results', 'runs',
                           'run_items', 'pending_tool_calls', 'traces'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON "public".%I', t || '_stamp_ws', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON "public".%I FOR EACH ROW '
                   'EXECUTE FUNCTION "public"."mantle_stamp_workspace_trg"()', t || '_stamp_ws', t);
  END LOOP;
END
$$;
