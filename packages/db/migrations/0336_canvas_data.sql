-- The canvas data store (DWG phase 7a; docs/proposals/canvas-files.md,
-- "The data store"). Small JSON values a Present canvas keeps through
-- `mantle.data`: meeting marks, saved layouts, suggestions, votes. A canvas
-- runs sandboxed with no network; its host page forwards each call to the
-- brain as the signed-in user, and binds the canvas.
--
-- One row per (canvas, key) in the `shared` bucket (login_id NULL), one per
-- (canvas, login, key) in `mine`. `bytes` is the size of the value's JSON
-- text, which the caps count (@mantle/content-core/canvas-data). NOT a canvas
-- revision: nothing here touches `presents` or its rev. A row goes with its
-- canvas (nodes cascade) and a `mine` row with its login. `updated_by` is the
-- login that last wrote a row and `by_name` its display name then (a
-- snapshot: a member's scope reads no other login's profile).
--
-- Rights, on the canvas's own item rights:
--  - read (the row rule below, for the workspace role): a row of a canvas
--    the scope reads, when it is `shared`, or the scope's own `mine` entry,
--    or the scope may edit the canvas (Write on it: it reads everyone's
--    `mine` entries).
--  - write: only the two definers below, called in the login's own scope
--    (packages/content/src/canvas-data.ts, in a transaction: the write role
--    for a member, the system pool with the scope set for an Admin user).
--    The login is the scope's own (mantle_scope_login_id), never an
--    argument. No role writes the table itself: the write role holds no
--    right on it and the runtime role reads it only (access-matrix.ts).
--
-- 1. mantle_canvas_data_put(canvas, bucket, key, json): save one entry. In
--    one transaction, under an advisory lock on the canvas (so two writes
--    to one canvas never both pass a cap): the canvas row is read FOR KEY
--    SHARE (a delete that ran first leaves no row: 'missing', never a
--    foreign key error); it must be a canvas the scope reads (the nodes row
--    rule: 'missing' otherwise, whether it exists or not), not a read-only
--    snapshot copy ('read_only'); `shared` asks Write on it
--    (mantle_may_edit: 'forbidden'). Then the caps, over every row of the
--    canvas but the one this write replaces ('full'): 1 MB and 1000 entries
--    per canvas; every login's `mine` entries together at most 75% of
--    those (768 KB, 750), so `shared` always keeps a quarter; one login's
--    `mine` entries 256 KB and 200. A value is JSON text of at most 64 KB
--    ('invalid' otherwise, and for a bucket or key the contract refuses).
--    The display name kept is the login's own (auth.users). Returns
--    (result, saved_at): 'ok' and the time, or the refusal.
-- 2. mantle_canvas_data_delete(canvas, bucket, key, login): remove entries.
--    `shared` and a key: Write on the canvas. `mine` and a key: the
--    login's own entry (login NULL or its own), or, with Write on the
--    canvas, another login's (moderation). All three NULL: clear every
--    entry of the canvas, both buckets, Write only. The same canvas checks
--    as a put. Returns (result, removed).
-- Both refuse (42501) outside a login's scope, and answer 'ro' to a
-- read-only caller (mantle.write_mode ro). The caps are pinned equal to
-- the contract's constants (packages/content/src/canvas-data.test.ts).
--
-- EXECUTE: taken from PUBLIC here; migrate gives it to the write role
-- (access-matrix.ts WRITE_ROLE_FUNCTIONS), and so to the runtime role (its
-- allowlist holds what a viewer role may run). Never the narrow role.
--
-- Grants come from the access matrix (applyViewerGrants), never from here.
-- Idempotent. The `when` sits above main's 0334's. Revert:
-- packages/db/rollback/0336_canvas_data.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."canvas_data" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "node_id" uuid NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "bucket" text NOT NULL,
  "key" text NOT NULL,
  "login_id" uuid REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "value" jsonb NOT NULL,
  "bytes" integer NOT NULL,
  "updated_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "by_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "canvas_data_bucket_ck" CHECK (
    ("bucket" = 'shared' AND "login_id" IS NULL)
    OR ("bucket" = 'mine' AND "login_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canvas_data_shared_key_uq"
  ON "public"."canvas_data" ("node_id", "key") WHERE "bucket" = 'shared';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canvas_data_mine_key_uq"
  ON "public"."canvas_data" ("node_id", "login_id", "key") WHERE "bucket" = 'mine';
--> statement-breakpoint

LOCK TABLE "public"."canvas_data" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "public"."canvas_data" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "canvas_data_user_read" ON "public"."canvas_data";
--> statement-breakpoint
CREATE POLICY "canvas_data_user_read" ON "public"."canvas_data" FOR SELECT TO mantle_view_user
  USING (EXISTS (
    SELECT 1 FROM "public"."nodes" n
     WHERE n.id = "canvas_data"."node_id"
       AND ("canvas_data"."bucket" = 'shared'
            OR "canvas_data"."login_id" = (SELECT "public"."mantle_login_id"())
            OR coalesce("public"."mantle_may_edit"(n."home_ws", n."write_ws"), false))));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_canvas_data_put"(
  canvas uuid, in_bucket text, in_key text, in_json text)
  RETURNS TABLE ("result" text, "saved_at" timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  -- @mantle/content-core/canvas-data, pinned by packages/content/src/canvas-data.test.ts.
  value_max CONSTANT integer := 65536;
  canvas_max_bytes CONSTANT bigint := 1048576;
  canvas_max_keys CONSTANT bigint := 1000;
  mine_max_bytes CONSTANT bigint := 786432;
  mine_max_keys CONSTANT bigint := 750;
  login_max_bytes CONSTANT bigint := 262144;
  login_max_keys CONSTANT bigint := 200;
  me uuid := "public"."mantle_scope_login_id"();
  who uuid;
  nm text;
  sz integer;
  v jsonb;
  c record;
  ub bigint;
  uk bigint;
  ts timestamptz;
BEGIN
  IF NOT "public"."mantle_scope_active"() OR me IS NULL THEN
    RAISE EXCEPTION 'mantle_canvas_data_put: only in a login''s own scope' USING ERRCODE = '42501';
  END IF;
  IF coalesce(current_setting('mantle.write_mode', true), '') = 'ro' THEN
    RETURN QUERY SELECT 'ro'::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF in_bucket IS NULL OR in_bucket NOT IN ('shared', 'mine')
     OR in_key IS NULL OR in_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
     OR in_json IS NULL OR octet_length(in_json) > value_max THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::timestamptz;
    RETURN;
  END IF;
  BEGIN
    v := in_json::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::timestamptz;
    RETURN;
  END;
  sz := octet_length(in_json);
  -- One writer per canvas at a time: the caps below count what is there.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canvas-data:' || canvas::text, 0));
  -- The canvas, held against a delete until this write commits.
  SELECT n."read_ws", n."home_ws", n."write_ws", n."login_id",
         coalesce(n."data" ? 'snapshot_of', false) AS copy
    INTO c
    FROM "public"."nodes" n
   WHERE n."id" = canvas AND n."type" = 'present'
     FOR KEY SHARE OF n;
  IF NOT FOUND
     OR NOT coalesce(c.read_ws && "public"."mantle_scope_ws"(), false)
     OR (c.login_id IS NOT NULL AND c.login_id IS DISTINCT FROM "public"."mantle_login_id"()) THEN
    RETURN QUERY SELECT 'missing'::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF c.copy THEN
    RETURN QUERY SELECT 'read_only'::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF in_bucket = 'shared' AND NOT coalesce("public"."mantle_may_edit"(c.home_ws, c.write_ws), false) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::timestamptz;
    RETURN;
  END IF;
  who := CASE WHEN in_bucket = 'mine' THEN me END;
  -- The caps, the row this write replaces left out.
  SELECT coalesce(sum(d."bytes"), 0), count(*) INTO ub, uk
    FROM "public"."canvas_data" d
   WHERE d."node_id" = canvas
     AND NOT (d."bucket" = in_bucket AND d."key" = in_key AND d."login_id" IS NOT DISTINCT FROM who);
  IF ub + sz > canvas_max_bytes OR uk + 1 > canvas_max_keys THEN
    RETURN QUERY SELECT 'full'::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF in_bucket = 'mine' THEN
    SELECT coalesce(sum(d."bytes"), 0), count(*) INTO ub, uk
      FROM "public"."canvas_data" d
     WHERE d."node_id" = canvas AND d."bucket" = 'mine'
       AND NOT (d."key" = in_key AND d."login_id" = who);
    IF ub + sz > mine_max_bytes OR uk + 1 > mine_max_keys THEN
      RETURN QUERY SELECT 'full'::text, NULL::timestamptz;
      RETURN;
    END IF;
    SELECT coalesce(sum(d."bytes"), 0), count(*) INTO ub, uk
      FROM "public"."canvas_data" d
     WHERE d."node_id" = canvas AND d."bucket" = 'mine' AND d."login_id" = who
       AND d."key" <> in_key;
    IF ub + sz > login_max_bytes OR uk + 1 > login_max_keys THEN
      RETURN QUERY SELECT 'full'::text, NULL::timestamptz;
      RETURN;
    END IF;
  END IF;
  SELECT left(nullif(btrim(u."display_name"), ''), 200) INTO nm
    FROM "auth"."users" u WHERE u."id" = me;
  IF in_bucket = 'shared' THEN
    INSERT INTO "public"."canvas_data" AS d
      ("node_id", "bucket", "key", "login_id", "value", "bytes", "updated_by", "by_name")
    VALUES (canvas, 'shared', in_key, NULL, v, sz, me, nm)
    ON CONFLICT ("node_id", "key") WHERE "bucket" = 'shared'
    DO UPDATE SET "value" = excluded."value", "bytes" = excluded."bytes",
                  "updated_by" = excluded."updated_by", "by_name" = excluded."by_name",
                  "updated_at" = now()
    RETURNING d."updated_at" INTO ts;
  ELSE
    INSERT INTO "public"."canvas_data" AS d
      ("node_id", "bucket", "key", "login_id", "value", "bytes", "updated_by", "by_name")
    VALUES (canvas, 'mine', in_key, who, v, sz, me, nm)
    ON CONFLICT ("node_id", "login_id", "key") WHERE "bucket" = 'mine'
    DO UPDATE SET "value" = excluded."value", "bytes" = excluded."bytes",
                  "updated_by" = excluded."updated_by", "by_name" = excluded."by_name",
                  "updated_at" = now()
    RETURNING d."updated_at" INTO ts;
  END IF;
  RETURN QUERY SELECT 'ok'::text, ts;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_canvas_data_put"(uuid, text, text, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_canvas_data_delete"(
  canvas uuid, in_bucket text, in_key text, in_login uuid)
  RETURNS TABLE ("result" text, "removed" integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  me uuid := "public"."mantle_scope_login_id"();
  clear boolean := in_bucket IS NULL AND in_key IS NULL AND in_login IS NULL;
  who uuid;
  need_write boolean;
  c record;
  gone integer;
BEGIN
  IF NOT "public"."mantle_scope_active"() OR me IS NULL THEN
    RAISE EXCEPTION 'mantle_canvas_data_delete: only in a login''s own scope' USING ERRCODE = '42501';
  END IF;
  IF coalesce(current_setting('mantle.write_mode', true), '') = 'ro' THEN
    RETURN QUERY SELECT 'ro'::text, 0;
    RETURN;
  END IF;
  IF NOT clear AND (
       in_bucket IS NULL OR in_bucket NOT IN ('shared', 'mine')
       OR in_key IS NULL OR in_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
       OR (in_bucket = 'shared' AND in_login IS NOT NULL)) THEN
    RETURN QUERY SELECT 'invalid'::text, 0;
    RETURN;
  END IF;
  who := CASE WHEN in_bucket = 'mine' THEN coalesce(in_login, me) END;
  need_write := clear OR in_bucket = 'shared' OR who IS DISTINCT FROM me;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canvas-data:' || canvas::text, 0));
  SELECT n."read_ws", n."home_ws", n."write_ws", n."login_id",
         coalesce(n."data" ? 'snapshot_of', false) AS copy
    INTO c
    FROM "public"."nodes" n
   WHERE n."id" = canvas AND n."type" = 'present';
  IF NOT FOUND
     OR NOT coalesce(c.read_ws && "public"."mantle_scope_ws"(), false)
     OR (c.login_id IS NOT NULL AND c.login_id IS DISTINCT FROM "public"."mantle_login_id"()) THEN
    RETURN QUERY SELECT 'missing'::text, 0;
    RETURN;
  END IF;
  IF c.copy THEN
    RETURN QUERY SELECT 'read_only'::text, 0;
    RETURN;
  END IF;
  IF need_write AND NOT coalesce("public"."mantle_may_edit"(c.home_ws, c.write_ws), false) THEN
    RETURN QUERY SELECT 'forbidden'::text, 0;
    RETURN;
  END IF;
  IF clear THEN
    DELETE FROM "public"."canvas_data" d WHERE d."node_id" = canvas;
  ELSE
    DELETE FROM "public"."canvas_data" d
     WHERE d."node_id" = canvas AND d."bucket" = in_bucket AND d."key" = in_key
       AND d."login_id" IS NOT DISTINCT FROM who;
  END IF;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN QUERY SELECT 'ok'::text, gone;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_canvas_data_delete"(uuid, text, text, uuid) FROM PUBLIC;
