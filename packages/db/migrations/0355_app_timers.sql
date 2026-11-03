-- App timers (docs/app-timers.md; docs/app-authoring-guide.md "Timers"): a
-- mini app's tool call on a clock, with no model and no person per run. One
-- row per timer: the app, a name unique in the app, one declared tool and its
-- arguments (one JSON object, at most 8 KB), every_minutes (1 to 1440),
-- keep_days (1 to 400: how long its runs stay in the app's own database),
-- the switch, the login it runs as (created_by: the last login that set it;
-- a removed login leaves NULL and the timer fails closed), and the
-- scheduler's bookkeeping: next_run_at, the last run's time, outcome
-- (last_error is a fixed short text, never a caught error's), duration, the
-- failures in a row, and the claim of the run in flight (claim_id,
-- claimed_at). A row goes with its app (nodes cascade): deleting the app
-- drops its timers.
--
-- Rights, on the app's own item rights:
--  - read (the row rule below, for the workspace role): the rows of an app
--    the scope manages (a Moderator of its home; an app with no home, an
--    Admin scope): mantle_may_manage_home, as app_table_exports (0302).
--  - write: the write role by the same rule (the matrix's write check
--    `manage` of app_node_id, mantle_write_check_trg; the write role sync
--    makes its write rules from the read rule). The app_timer tools write in
--    the caller's scope; the scheduler (the maintenance worker, system work)
--    on the system pool.
--
-- The caps, in the database whatever the writer: at most 5 timers per app,
-- 20 per login (created_by), 100 per box, and of those at most 80 set by
-- logins that are no Admin user (the last 20 kept for Admin users:
-- mantle_login_is_admin), counted under one advisory lock so two writes
-- never both pass (mantle_app_timers_cap, a definer: the writing scope
-- reads only its own apps' rows, the cap counts every row). On an insert,
-- and on an update that moves a timer to another app or another login (a
-- set by another manager re-stamps created_by); an update of anything
-- else, and a login's removal (created_by set NULL), is not counted again. It raises 23514 with the constraint
-- app_timers_per_app_cap, app_timers_per_login_cap, app_timers_box_cap or
-- app_timers_admin_reserve_cap. EXECUTE is taken from PUBLIC: only its
-- trigger runs it.
--
-- The actor check's statement trigger and the edit check's two item
-- triggers, as every content table (0302 for profiles), switched by the box
-- modes; and the narrow role's off-only rule on `enabled` (0324, 0325).
--
-- Grants come from the access matrix (applyViewerGrants), never from here.
-- Additive, no rewrite, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0355_app_timers.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."app_timers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "app_node_id" uuid NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "tool_slug" text NOT NULL,
  "args" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "every_minutes" integer DEFAULT 5 NOT NULL,
  "keep_days" integer DEFAULT 90 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_run_at" timestamp with time zone,
  "last_ok" boolean,
  "last_error" text,
  "last_ms" integer,
  "fail_count" integer DEFAULT 0 NOT NULL,
  "claim_id" uuid,
  "claimed_at" timestamp with time zone,
  CONSTRAINT "app_timers_name_ck" CHECK ("name" ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  CONSTRAINT "app_timers_tool_ck" CHECK (char_length("tool_slug") BETWEEN 1 AND 120),
  CONSTRAINT "app_timers_args_ck" CHECK (
    jsonb_typeof("args") = 'object' AND octet_length("args"::text) <= 8192),
  CONSTRAINT "app_timers_every_ck" CHECK ("every_minutes" BETWEEN 1 AND 1440),
  CONSTRAINT "app_timers_keep_ck" CHECK ("keep_days" BETWEEN 1 AND 400),
  CONSTRAINT "app_timers_error_ck" CHECK ("last_error" IS NULL OR char_length("last_error") <= 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_timers_app_name_uq"
  ON "public"."app_timers" ("app_node_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_timers_due_idx"
  ON "public"."app_timers" ("next_run_at") WHERE "enabled";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_timers_created_by_idx"
  ON "public"."app_timers" ("created_by") WHERE "created_by" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_timers_owner_idx" ON "public"."app_timers" ("owner_id");
--> statement-breakpoint

-- The caps (see the head). A definer with a fixed search_path, pg_temp last.
CREATE OR REPLACE FUNCTION "public"."mantle_app_timers_cap"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  moved_app boolean := TG_OP = 'INSERT' OR new."app_node_id" IS DISTINCT FROM old."app_node_id";
  moved_login boolean := TG_OP = 'INSERT' OR new."created_by" IS DISTINCT FROM old."created_by";
BEGIN
  -- Nothing moved, or only the login went (a removed login's ON DELETE SET
  -- NULL, an update of created_by to NULL): a removal only lowers the
  -- counts, so it is never refused (offboarding a login always works).
  IF NOT moved_app AND (NOT moved_login OR new."created_by" IS NULL) THEN
    RETURN new;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('mantle_app_timers_cap'));
  IF moved_app AND (SELECT count(*) FROM "public"."app_timers" t
       WHERE t."app_node_id" = new."app_node_id" AND t."id" <> new."id") >= 5 THEN
    RAISE EXCEPTION 'an app has at most 5 timers'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'app_timers_per_app_cap';
  END IF;
  IF moved_login AND new."created_by" IS NOT NULL AND (SELECT count(*) FROM "public"."app_timers" t
       WHERE t."created_by" = new."created_by" AND t."id" <> new."id") >= 20 THEN
    RAISE EXCEPTION 'a login sets at most 20 app timers'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'app_timers_per_login_cap';
  END IF;
  IF TG_OP = 'INSERT' AND (SELECT count(*) FROM "public"."app_timers") >= 100 THEN
    RAISE EXCEPTION 'a box has at most 100 app timers'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'app_timers_box_cap';
  END IF;
  IF moved_login
     AND NOT coalesce("public"."mantle_login_is_admin"(new."created_by"), false)
     AND (SELECT count(*) FROM "public"."app_timers" t
           WHERE t."id" <> new."id"
             AND NOT coalesce("public"."mantle_login_is_admin"(t."created_by"), false)) >= 80 THEN
    RAISE EXCEPTION 'logins that are no Admin user set at most 80 app timers'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'app_timers_admin_reserve_cap';
  END IF;
  RETURN new;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_app_timers_cap"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "app_timers_cap" ON "public"."app_timers";
--> statement-breakpoint
CREATE TRIGGER "app_timers_cap" BEFORE INSERT OR UPDATE OF "app_node_id", "created_by"
  ON "public"."app_timers"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_app_timers_cap"();
--> statement-breakpoint

LOCK TABLE "public"."app_timers" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "public"."app_timers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "app_timers_user_read" ON "public"."app_timers";
--> statement-breakpoint
-- The rule's test is mantle_may_manage_home (0279), which 0302 gave the
-- workspace role (the write role follows it).
CREATE POLICY "app_timers_user_read" ON "public"."app_timers" FOR SELECT
  TO mantle_view_user
  USING (EXISTS (
    SELECT 1 FROM "public"."nodes" a
     WHERE a."id" = "app_timers"."app_node_id"
       AND "public"."mantle_may_manage_home"(a."home_ws")));
--> statement-breakpoint

DROP TRIGGER IF EXISTS "mantle_actor_check" ON "public"."app_timers";
--> statement-breakpoint
CREATE TRIGGER "mantle_actor_check" BEFORE INSERT OR UPDATE OR DELETE ON "public"."app_timers"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_actor_check_stmt"();
--> statement-breakpoint
DO $$ BEGIN
  IF "public"."mantle_actor_check_box_mode"() = 'off' THEN
    ALTER TABLE "public"."app_timers" DISABLE TRIGGER "mantle_actor_check";
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "mantle_edit_check_ro" BEFORE INSERT OR UPDATE OR DELETE ON "public"."app_timers"
  FOR EACH STATEMENT WHEN (current_setting('mantle.write_mode', true) = 'ro')
  EXECUTE FUNCTION "public"."mantle_edit_ro_stmt"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "mantle_edit_check_contact" BEFORE INSERT OR UPDATE OR DELETE ON "public"."app_timers"
  FOR EACH STATEMENT WHEN (current_setting('mantle.actor', true) = 'contact:rw')
  EXECUTE FUNCTION "public"."mantle_edit_contact_stmt"();
--> statement-breakpoint
DO $$ BEGIN
  IF "public"."mantle_check_box_mode"('edit_check') = 'off' THEN
    ALTER TABLE "public"."app_timers" DISABLE TRIGGER "mantle_edit_check_ro";
    ALTER TABLE "public"."app_timers" DISABLE TRIGGER "mantle_edit_check_contact";
  END IF;
END $$;
--> statement-breakpoint
-- The enable class on the narrow role (0324, 0325): a timer's switch only
-- goes off there, on an update or an insert (the narrow role writes no row
-- of this content table anyway; the rule keeps the catalog's one shape).
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."app_timers";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE INSERT OR UPDATE ON "public"."app_timers"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('off:enabled');
