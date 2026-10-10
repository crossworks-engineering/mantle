-- Workspaces, phase W1: the model in shadow (plan page 4887b8e7, sections
-- 1, 2, 17 to 21). Nothing in the product reads these tables yet; they stay
-- empty on dev until W4. What W1 adds:
--
--  - workspaces, workspace_users, item_grants, workspace_resources,
--    workspace_events: the model. item_grants is the ONE truth for sharing.
--  - node_acl_head: one narrow row per node; every writer of access or
--    derived rows locks heads FIRST (mantle_lock_heads), so no writer can
--    deadlock another or miss its change (sections 20 and 21).
--  - nodes.read_ws / write_ws / home_ws and the copies on content_chunks,
--    content_chunk_windows and facts: derived from item_grants by triggers in
--    the same transaction, never written by the app. Row security for the
--    new user role reads them (migration 0242).
--  - login_id on nodes and the derived rows (per-login privacy, S4).
--  - agents.workspace_id, frozen once the assistant has history.
--  - The heads check (off | warn | on, per box by
--    ALTER DATABASE ... SET mantle.heads_check). Unset means 'warn': a miss
--    is logged once per transaction and counted, nothing fails.
--
-- No trigger here starts LLM work: grant triggers write arrays only, and the
-- node_ingested notify fires on INSERT of nodes, never on these updates.
-- Every trigger function is SECURITY DEFINER with a pinned search_path, so a
-- limited role (the personal-space role) needs no grant on the new tables.
-- Two guards are SECURITY INVOKER on purpose: they must see the role that
-- ran the statement (mantle_acl_writer).

-- Every table this migration alters, locked first and briefly (audit L10):
-- a busy box fails fast and the migration is run again, never a long wait
-- holding half the locks.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
LOCK TABLE "public"."nodes", "public"."content_chunks", "public"."content_chunk_windows",
  "public"."facts", "public"."agents" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

-- ── The model ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "public"."workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL REFERENCES "public"."spaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  -- Information only (who this workspace represents); never a permission.
  "contact_id" uuid REFERENCES "public"."nodes"("id") ON DELETE SET NULL,
  "is_admin" boolean NOT NULL DEFAULT false,
  -- Admin workspace users are Moderators here, kept by trigger (plan 19.5).
  "admin_moderated" boolean NOT NULL DEFAULT false,
  "created_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "archived_at" timestamptz,
  CONSTRAINT "workspaces_name_ck" CHECK (length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "workspaces_admin_live_ck" CHECK (NOT "is_admin" OR "archived_at" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_one_admin_uq"
  ON "public"."workspaces" ("owner_id") WHERE "is_admin";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_live_name_uq"
  ON "public"."workspaces" ("owner_id", lower("name")) WHERE "archived_at" IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."workspace_users" (
  "workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
  "login_id" uuid NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "moderator" boolean NOT NULL DEFAULT false,
  -- Future per-user area switches (Admin workspace only); empty = all on.
  "limits" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "added_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "added_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "login_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_users_login_idx"
  ON "public"."workspace_users" ("login_id");
--> statement-breakpoint

-- One row per (item, workspace). is_home marks the item's home (exactly one
-- per item once homes exist); via_folder_id marks a row derived from the
-- item's folder (NULL = set on the item by hand); excluded marks "removed
-- here" against a folder's grant (19.5).
CREATE TABLE IF NOT EXISTS "public"."item_grants" (
  "node_id" uuid NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  -- NO ACTION, not RESTRICT (audit L7): checked at the end of the
  -- statement, so a cascade that removes the item too (a space deleted)
  -- passes, and a workspace still holding grants on its own cannot go.
  "workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE NO ACTION,
  "write" boolean NOT NULL DEFAULT false,
  "is_home" boolean NOT NULL DEFAULT false,
  "via_folder_id" uuid REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "excluded" boolean NOT NULL DEFAULT false,
  "granted_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "granted_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("node_id", "workspace_id"),
  CONSTRAINT "item_grants_home_not_excluded_ck" CHECK (NOT ("is_home" AND "excluded"))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_grants_workspace_idx"
  ON "public"."item_grants" ("workspace_id", "node_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "item_grants_one_home_uq"
  ON "public"."item_grants" ("node_id") WHERE "is_home";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_grants_via_folder_idx"
  ON "public"."item_grants" ("via_folder_id") WHERE "via_folder_id" IS NOT NULL;
--> statement-breakpoint

-- Workspace resources (1.4): the assistant and connectors now; later types
-- are one more CHECK value. Write applies when the user is a Moderator.
CREATE TABLE IF NOT EXISTS "public"."workspace_resources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "ref_id" text NOT NULL,
  "write" boolean NOT NULL DEFAULT false,
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "added_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "added_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_resources_type_ck" CHECK ("type" IN ('assistant', 'connector'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_resources_uq"
  ON "public"."workspace_resources" ("workspace_id", "type", "ref_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_resources_one_assistant_uq"
  ON "public"."workspace_resources" ("workspace_id") WHERE "type" = 'assistant';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_resources_assistant_home_uq"
  ON "public"."workspace_resources" ("ref_id") WHERE "type" = 'assistant';
--> statement-breakpoint

-- Every membership, moderator, grant-policy, resource and area change.
-- Append only (the app inserts; nothing updates or deletes).
CREATE TABLE IF NOT EXISTS "public"."workspace_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid REFERENCES "public"."workspaces"("id") ON DELETE SET NULL,
  "actor_id" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "action" text NOT NULL,
  "subject" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_events_ws_idx"
  ON "public"."workspace_events" ("workspace_id", "at" DESC);
--> statement-breakpoint

-- ── Heads ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "public"."node_acl_head" (
  "node_id" uuid PRIMARY KEY REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "version" bigint NOT NULL DEFAULT 0
);
--> statement-breakpoint
-- Every existing node gets its head. Safe from a racing insert: nodes is
-- locked ACCESS EXCLUSIVE since the start of this migration, and the insert
-- trigger exists before the lock is released (audit M3). mantle_lock_heads
-- also creates a missing head, as a second line.
INSERT INTO "public"."node_acl_head" ("node_id")
  SELECT "id" FROM "public"."nodes"
  ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- One row per (transaction, check) that missed its heads in 'warn' mode:
-- inserts only, never an update, so it adds no lock contention.
CREATE TABLE IF NOT EXISTS "public"."heads_check_misses" (
  "id" bigserial PRIMARY KEY,
  "at" timestamptz NOT NULL DEFAULT now(),
  "check_name" text NOT NULL,
  "node_id" uuid,
  "detail" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heads_check_misses_at_idx"
  ON "public"."heads_check_misses" ("at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heads_check_misses_check_idx"
  ON "public"."heads_check_misses" ("check_name", "at" DESC);
--> statement-breakpoint
-- The key the held-heads list is signed with (audit L6): a session that sets
-- mantle.heads_held by hand cannot sign it. One random row, read only by the
-- security definer functions (no grant, row security on, no policy).
CREATE TABLE IF NOT EXISTS "public"."mantle_heads_key" (
  "id" boolean PRIMARY KEY DEFAULT true CHECK ("id"),
  "k" text NOT NULL DEFAULT (gen_random_uuid()::text || gen_random_uuid()::text)
);
--> statement-breakpoint
INSERT INTO "public"."mantle_heads_key" DEFAULT VALUES ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "public"."mantle_heads_key" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ── Derived columns ──────────────────────────────────────────────────────────
-- Constant defaults: metadata only, no table rewrite.

ALTER TABLE "public"."nodes"
  ADD COLUMN IF NOT EXISTS "home_ws" uuid,
  ADD COLUMN IF NOT EXISTS "read_ws" uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS "write_ws" uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."content_chunks"
  ADD COLUMN IF NOT EXISTS "read_ws" uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."content_chunk_windows"
  ADD COLUMN IF NOT EXISTS "read_ws" uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."facts"
  ADD COLUMN IF NOT EXISTS "read_ws" uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."agents"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "public"."workspaces"("id") ON DELETE NO ACTION;
--> statement-breakpoint

-- ── Scope ────────────────────────────────────────────────────────────────────
-- The scope GUCs are transaction-local, set by withScope (@mantle/db). No
-- setting = an empty array: a forgotten scope reads nothing.

CREATE OR REPLACE FUNCTION "public"."mantle_scope_ws"()
  RETURNS uuid[] LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(nullif(current_setting('mantle.ws', true), '')::uuid[], '{}'::uuid[])
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_scope_mod_ws"()
  RETURNS uuid[] LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(nullif(current_setting('mantle.mod_ws', true), '')::uuid[], '{}'::uuid[])
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_scope_active"()
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(current_setting('mantle.ws', true), '') <> ''
$$;
--> statement-breakpoint
-- Edit: a Moderator of the home, or a grant with Write on in the scope (R1).
CREATE OR REPLACE FUNCTION "public"."mantle_may_edit"(home uuid, write_ws uuid[])
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT (home IS NOT NULL AND home = ANY ("public"."mantle_scope_mod_ws"()))
      OR coalesce(write_ws && "public"."mantle_scope_ws"(), false)
$$;
--> statement-breakpoint
-- Manage (grants, Write, links, delete, move): Moderators of the home only.
CREATE OR REPLACE FUNCTION "public"."mantle_may_manage"(home uuid)
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT home IS NOT NULL AND home = ANY ("public"."mantle_scope_mod_ws"())
$$;
--> statement-breakpoint

-- ONE list of kind classes (R8): 'workspace' kinds are shared by grants;
-- 'admin_only' kinds live only in the Admin workspace; 'conversation' kinds
-- belong to the workspace of the assistant that holds the chat.
CREATE OR REPLACE FUNCTION "public"."mantle_kind_class"(t "public"."node_type")
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN t IN ('branch', 'file', 'note', 'page', 'table', 'app', 'formula', 'draw',
               'task', 'event', 'recall') THEN 'workspace'
    WHEN t = 'telegram_message' THEN 'conversation'
    ELSE 'admin_only'
  END
$$;
--> statement-breakpoint
-- Whether a grant of kind `t` to workspace `ws` is allowed at all.
-- Whether a grant of kind `t` to workspace `ws` is allowed at all, and
-- whether a FOLDER may pass it on (`derived`): a conversation row belongs to
-- the workspace of the assistant that holds the chat, set by hand, never
-- taken from a folder (plan R8). mantle_workspace_kind (0159) is the tier
-- model's list and goes with it in W8; this is the workspace model's.
CREATE OR REPLACE FUNCTION "public"."mantle_grant_kind_ok"(t "public"."node_type", ws uuid, derived boolean DEFAULT false)
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = "public", pg_temp AS $$
  SELECT CASE "public"."mantle_kind_class"(t)
    WHEN 'workspace' THEN true
    WHEN 'conversation' THEN NOT derived
    ELSE EXISTS (SELECT 1 FROM "public"."workspaces" w WHERE w."id" = ws AND w."is_admin")
  END
$$;
--> statement-breakpoint
-- The derivation's own writes are marked by a transaction-local flag, set
-- and restored by the functions below. The guards on the derived columns
-- (audit M4) and the propagation trigger (audit L9) read it.
CREATE OR REPLACE FUNCTION "public"."mantle_acl_internal"()
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(current_setting('mantle.acl_internal', true), '') = 'on'
$$;
--> statement-breakpoint
-- The flag alone is not proof: any session may set a custom setting, the
-- personal-space role included, and that role may UPDATE nodes. A write of
-- the derived columns counts as the derivation's only when the flag is on
-- AND the current role is the one the derivation runs as (the owner of the
-- security definer functions below; inside them current_user is that
-- owner). Called from SECURITY INVOKER guards, so current_user here is the
-- role that ran the statement.
CREATE OR REPLACE FUNCTION "public"."mantle_acl_writer"()
  RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT "public"."mantle_acl_internal"()
     AND pg_has_role(current_user,
                     (SELECT p.proowner FROM pg_proc p
                       WHERE p.oid = 'public.mantle_acl_internal()'::regprocedure),
                     'USAGE')
$$;
--> statement-breakpoint

-- ── The heads check ──────────────────────────────────────────────────────────

-- The mode: the box setting (ALTER DATABASE ... SET mantle.heads_check), read
-- from the catalog so a session cannot lower it; a session may only make it
-- stricter (a test turning 'on' in its own transaction). Audit L6.
CREATE OR REPLACE FUNCTION "public"."mantle_heads_check_mode"()
  RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  box text;
  sess text := coalesce(nullif(current_setting('mantle.heads_check', true), ''), 'warn');
  rank_box int;
  rank_sess int;
BEGIN
  SELECT split_part(c, '=', 2) INTO box
    FROM pg_db_role_setting d, unnest(d.setconfig) AS c
   WHERE d.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND d.setrole = 0 AND c LIKE 'mantle.heads_check=%'
   LIMIT 1;
  box := coalesce(box, 'warn');
  rank_box := CASE box WHEN 'off' THEN 0 WHEN 'on' THEN 2 ELSE 1 END;
  rank_sess := CASE sess WHEN 'off' THEN 0 WHEN 'on' THEN 2 ELSE 1 END;
  RETURN CASE greatest(rank_box, rank_sess) WHEN 0 THEN 'off' WHEN 2 THEN 'on' ELSE 'warn' END;
END
$$;
--> statement-breakpoint
-- The held list, trusted only when its signature matches (audit L6): the
-- list and the update-locked subset, signed with the key and this
-- transaction's id, so a hand-set list (or one from another transaction)
-- reads as empty.
CREATE OR REPLACE FUNCTION "public"."mantle_heads_sig"(held text, held_upd text)
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT md5((SELECT "k" FROM "public"."mantle_heads_key" LIMIT 1)
             || ':' || txid_current()::text || ':' || held || ':' || held_upd)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_heads_held"(update_only boolean DEFAULT false)
  RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  held text := coalesce(current_setting('mantle.heads_held', true), '');
  held_upd text := coalesce(current_setting('mantle.heads_held_upd', true), '');
BEGIN
  IF held = '' OR coalesce(current_setting('mantle.heads_sig', true), '')
                  <> "public"."mantle_heads_sig"(held, held_upd) THEN
    RETURN '{}'::uuid[];
  END IF;
  RETURN (CASE WHEN update_only THEN nullif(held_upd, '') ELSE held END)::uuid[];
END
$$;
--> statement-breakpoint
-- Record the held lists (and sign them). Definer only.
CREATE OR REPLACE FUNCTION "public"."mantle_heads_set"(held uuid[], held_upd uuid[])
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  h text := (SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[])::text
               FROM unnest(held) AS x WHERE x IS NOT NULL);
  u text := (SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[])::text
               FROM unnest(held_upd) AS x WHERE x IS NOT NULL);
BEGIN
  PERFORM set_config('mantle.heads_held', h, true);
  PERFORM set_config('mantle.heads_held_upd', u, true);
  PERFORM set_config('mantle.heads_sig', "public"."mantle_heads_sig"(h, u), true);
END
$$;
--> statement-breakpoint

-- A check that found heads missing. 'warn': one WARNING and one log row per
-- transaction and check name; 'on': SQLSTATE 40001 (retryable by the caller).
-- A check that found heads missing. 'warn': one WARNING per transaction and
-- check, and a log row while that check logged fewer than 100 in the last
-- hour (audit L12: bounded); 'on': SQLSTATE 40001 (retryable by the caller).
CREATE OR REPLACE FUNCTION "public"."mantle_heads_miss"(check_name text, node uuid, detail text)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  mode text := "public"."mantle_heads_check_mode"();
  seen_key text := 'mantle.heads_missed_' || md5(check_name);
BEGIN
  IF mode = 'off' THEN RETURN; END IF;
  IF mode = 'on' THEN
    RAISE EXCEPTION 'heads not held for % (node %): %', check_name, node, detail
      USING ERRCODE = '40001';
  END IF;
  IF coalesce(current_setting(seen_key, true), '') = '1' THEN RETURN; END IF;
  PERFORM set_config(seen_key, '1', true);
  RAISE WARNING 'heads not held for % (node %): %', check_name, node, detail;
  IF (SELECT count(*) FROM (SELECT 1 FROM "public"."heads_check_misses" m
                             WHERE m."check_name" = mantle_heads_miss.check_name
                               AND m."at" > now() - interval '1 hour' LIMIT 100) x) < 100 THEN
    INSERT INTO "public"."heads_check_misses" ("check_name", "node_id", "detail")
      VALUES (check_name, node, left(detail, 500));
  END IF;
END
$$;
--> statement-breakpoint

-- Require that every id in `ids` has its head held in this transaction.
-- Require that every id in `ids` has its head held in this transaction
-- (`need_update`: held FOR UPDATE, as a grant change or a chunk rewrite
-- must; a new item in a folder needs only a share lock on the folder).
CREATE OR REPLACE FUNCTION "public"."mantle_heads_require"(ids uuid[], check_name text, need_update boolean DEFAULT false)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  missing uuid;
  held uuid[];
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 OR "public"."mantle_heads_check_mode"() = 'off' THEN
    RETURN;
  END IF;
  held := "public"."mantle_heads_held"(need_update);
  SELECT x INTO missing
    FROM unnest(ids) AS x
   WHERE x IS NOT NULL AND NOT (x = ANY (held))
   LIMIT 1;
  IF missing IS NOT NULL THEN
    PERFORM "public"."mantle_heads_miss"(check_name, missing,
      CASE WHEN need_update THEN 'head not locked first for update' ELSE 'head not locked first' END);
  END IF;
END
$$;
--> statement-breakpoint

-- Lock heads FIRST (U1, V2): one statement ordered by node id, before the
-- transaction has written or locked anything (pg_current_xact_id_if_assigned
-- is NULL until then). Called once per transaction; only
-- mantle_lock_heads_more may add heads later.
-- Lock heads FIRST (U1, V2): one statement ordered by node id, before the
-- transaction has written or locked anything (pg_current_xact_id_if_assigned
-- is NULL until then). Called once per transaction; only
-- mantle_lock_heads_more may add heads later. A node with no head row yet
-- gets one first (audit M3).
CREATE OR REPLACE FUNCTION "public"."mantle_lock_heads"(ids uuid[], lock_mode text)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF lock_mode NOT IN ('update', 'share') THEN
    RAISE EXCEPTION 'mantle_lock_heads: mode must be update or share, got %', lock_mode;
  END IF;
  IF coalesce(current_setting('mantle.heads_held', true), '') <> '' THEN
    RAISE EXCEPTION 'mantle_lock_heads: heads are already held in this transaction; use mantle_lock_heads_more'
      USING ERRCODE = '55000';
  END IF;
  IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
    IF "public"."mantle_heads_check_mode"() = 'on' THEN
      RAISE EXCEPTION 'mantle_lock_heads: heads must be the first lock of the transaction'
        USING ERRCODE = '55000';
    END IF;
    PERFORM "public"."mantle_heads_miss"('lock_heads_first', NULL, 'transaction wrote or locked before taking heads');
  END IF;
  INSERT INTO "public"."node_acl_head" ("node_id")
    SELECT n."id" FROM "public"."nodes" n
     WHERE n."id" = ANY (ids)
       AND NOT EXISTS (SELECT 1 FROM "public"."node_acl_head" h WHERE h."node_id" = n."id")
    ON CONFLICT DO NOTHING;
  IF lock_mode = 'update' THEN
    PERFORM 1 FROM "public"."node_acl_head" h
      WHERE h."node_id" = ANY (ids) ORDER BY h."node_id" FOR UPDATE;
    PERFORM "public"."mantle_heads_set"(ids, ids);
  ELSE
    PERFORM 1 FROM "public"."node_acl_head" h
      WHERE h."node_id" = ANY (ids) ORDER BY h."node_id" FOR SHARE;
    PERFORM "public"."mantle_heads_set"(ids, '{}'::uuid[]);
  END IF;
END
$$;
--> statement-breakpoint

-- Add heads in a later round (U2, V1): NOWAIT, so a later round never waits
-- (a busy head raises 55P03 and the caller retries the whole transaction).
-- Only while heads are already held.
-- Add heads in a later round (U2, V1): NOWAIT, so a later round never waits
-- (a busy head raises 55P03 and the caller retries the whole transaction).
-- Only while heads are already held; always FOR UPDATE.
CREATE OR REPLACE FUNCTION "public"."mantle_lock_heads_more"(ids uuid[])
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  held uuid[] := "public"."mantle_heads_held"();
  held_upd uuid[] := "public"."mantle_heads_held"(true);
  add uuid[];
BEGIN
  IF cardinality(held) = 0 THEN
    RAISE EXCEPTION 'mantle_lock_heads_more: no heads held yet' USING ERRCODE = '55000';
  END IF;
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[]) INTO add
    FROM unnest(ids) AS x WHERE x IS NOT NULL AND NOT (x = ANY (held_upd));
  IF cardinality(add) = 0 THEN RETURN; END IF;
  INSERT INTO "public"."node_acl_head" ("node_id")
    SELECT n."id" FROM "public"."nodes" n
     WHERE n."id" = ANY (add)
       AND NOT EXISTS (SELECT 1 FROM "public"."node_acl_head" h WHERE h."node_id" = n."id")
    ON CONFLICT DO NOTHING;
  PERFORM 1 FROM "public"."node_acl_head" h
    WHERE h."node_id" = ANY (add) ORDER BY h."node_id" FOR UPDATE NOWAIT;
  PERFORM "public"."mantle_heads_set"(held || add, held_upd || add);
END
$$;
--> statement-breakpoint

-- Lock a whole subtree's heads (plus `extra`, such as a move's old and new
-- folder) as the FIRST lock: round 1 waits, rounds 2 to 5 re-select the
-- subtree by its current paths and lock new heads NOWAIT, until none appear
-- (U2, V1, V3). For a folder change (root = the folder) and a move (root =
-- the moved row, extra = both folders).
CREATE OR REPLACE FUNCTION "public"."mantle_lock_subtree_heads"(root uuid, extra uuid[])
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  r record;
  ids uuid[];
  rounds int := 0;
BEGIN
  SELECT "owner_id", "path", "type" INTO r FROM "public"."nodes" WHERE "id" = root;
  IF NOT FOUND THEN
    PERFORM "public"."mantle_lock_heads"(coalesce(extra, '{}'::uuid[]), 'update');
    RETURN;
  END IF;
  SELECT coalesce(array_agg(n."id"), '{}'::uuid[]) INTO ids
    FROM "public"."nodes" n
   WHERE n."id" = root
      OR (r."type" = 'branch' AND n."owner_id" = r."owner_id" AND n."path" <@ r."path");
  PERFORM "public"."mantle_lock_heads"(
    ids || coalesce(extra, '{}'::uuid[])
        || coalesce(ARRAY["public"."mantle_parent_folder"(r."owner_id", r."type", r."path")], '{}'::uuid[]),
    'update');
  IF r."type" <> 'branch' THEN RETURN; END IF;
  LOOP
    SELECT coalesce(array_agg(n."id" ORDER BY n."id"), '{}'::uuid[]) INTO ids
      FROM "public"."nodes" n
     WHERE n."owner_id" = r."owner_id"
       AND n."path" <@ (SELECT x."path" FROM "public"."nodes" x WHERE x."id" = root)
       AND NOT (n."id" = ANY ("public"."mantle_heads_held"()));
    EXIT WHEN cardinality(ids) = 0;
    rounds := rounds + 1;
    IF rounds > 5 THEN
      RAISE EXCEPTION 'mantle_lock_subtree_heads: subtree kept growing' USING ERRCODE = '40001';
    END IF;
    PERFORM "public"."mantle_lock_heads_more"(ids);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ── Derivation ───────────────────────────────────────────────────────────────

-- The folder an item sits in: an item's path IS its folder's path; a
-- folder's parent folder is one level up. Root kind rows (one label) are not
-- folders that can carry grants.
CREATE OR REPLACE FUNCTION "public"."mantle_parent_folder_path"(t "public"."node_type", p ltree)
  RETURNS ltree LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN t = 'branch' AND nlevel(p) > 2 THEN subpath(p, 0, nlevel(p) - 1)
    WHEN t <> 'branch' AND nlevel(p) >= 2 THEN p
    ELSE NULL
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_parent_folder"(o uuid, t "public"."node_type", p ltree)
  RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = "public", pg_temp AS $$
  SELECT f."id" FROM "public"."nodes" f
   WHERE f."owner_id" = o AND f."type" = 'branch'
     AND f."path" = "public"."mantle_parent_folder_path"(t, p)
   LIMIT 1
$$;
--> statement-breakpoint

-- Recompute the derived columns of `ids` from item_grants, then copy them to
-- the rows that follow those nodes. Writes only what changed.
-- Recompute the derived columns of `ids` from item_grants, then copy them to
-- the rows that follow those nodes. Writes only what changed, under the
-- internal flag (the guards let only this write the derived columns).
CREATE OR REPLACE FUNCTION "public"."mantle_acl_refresh"(ids uuid[])
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  was text := coalesce(current_setting('mantle.acl_internal', true), '');
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  PERFORM set_config('mantle.acl_internal', 'on', true);
  UPDATE "public"."nodes" n
     SET "read_ws" = x.r, "write_ws" = x.w, "home_ws" = x.h
    FROM (
      SELECT i.id,
             coalesce(array_agg(g."workspace_id" ORDER BY g."workspace_id")
                        FILTER (WHERE g."workspace_id" IS NOT NULL AND NOT g."excluded"),
                      '{}'::uuid[]) AS r,
             coalesce(array_agg(g."workspace_id" ORDER BY g."workspace_id")
                        FILTER (WHERE g."write" AND NOT g."excluded"),
                      '{}'::uuid[]) AS w,
             (array_agg(g."workspace_id") FILTER (WHERE g."is_home"))[1] AS h
        FROM (SELECT DISTINCT unnest(ids) AS id) i
        LEFT JOIN "public"."item_grants" g ON g."node_id" = i.id
       GROUP BY i.id
    ) x
   WHERE n."id" = x.id
     AND (n."read_ws", n."write_ws", n."home_ws") IS DISTINCT FROM (x.r, x.w, x.h);

  UPDATE "public"."content_chunks" c
     SET "read_ws" = n."read_ws", "login_id" = n."login_id"
    FROM "public"."nodes" n
   WHERE n."id" = ANY (ids) AND c."node_id" = n."id"
     AND (c."read_ws", c."login_id") IS DISTINCT FROM (n."read_ws", n."login_id");
  UPDATE "public"."content_chunk_windows" c
     SET "read_ws" = n."read_ws", "login_id" = n."login_id"
    FROM "public"."nodes" n
   WHERE n."id" = ANY (ids) AND c."node_id" = n."id"
     AND (c."read_ws", c."login_id") IS DISTINCT FROM (n."read_ws", n."login_id");
  UPDATE "public"."facts" f
     SET "read_ws" = n."read_ws", "login_id" = n."login_id"
    FROM "public"."nodes" n
   WHERE n."id" = ANY (ids) AND f."source_node_id" = n."id"
     AND (f."read_ws", f."login_id") IS DISTINCT FROM (n."read_ws", n."login_id");
  PERFORM set_config('mantle.acl_internal', was, true);
END
$$;
--> statement-breakpoint

-- Re-derive the folder rows of the items in one subtree, top down: every
-- derived row of an item comes from its direct folder's effective rows
-- (nearest ancestor wins by construction). Hand rows, home rows and
-- exclusions are never touched. `root` is a node id: for a folder the whole
-- subtree, for an item the item alone; `with_root` also re-derives the root
-- from its own folder (a move).
CREATE OR REPLACE FUNCTION "public"."mantle_rederive_subtree"(root uuid, with_root boolean)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  r record;
  lvl int;
  max_lvl int;
BEGIN
  SELECT "id", "owner_id", "type", "path" INTO r FROM "public"."nodes" WHERE "id" = root;
  IF NOT FOUND THEN RETURN; END IF;

  IF r."type" <> 'branch' THEN
    -- One item: re-derive it from its folder.
    PERFORM "public"."mantle_rederive_nodes"(ARRAY[root]);
    RETURN;
  END IF;

  IF with_root THEN
    PERFORM "public"."mantle_rederive_nodes"(ARRAY[root]);
  END IF;
  SELECT max(nlevel(n."path")) INTO max_lvl
    FROM "public"."nodes" n
   WHERE n."owner_id" = r."owner_id" AND n."path" <@ r."path";
  -- Items in a folder share its level; a sub-folder is one level deeper. So
  -- at each level: first the items whose folder is at that level, then the
  -- sub-folders whose parent is.
  FOR lvl IN nlevel(r."path") .. coalesce(max_lvl, nlevel(r."path")) LOOP
    PERFORM "public"."mantle_rederive_nodes"(ARRAY(
      SELECT n."id" FROM "public"."nodes" n
       WHERE n."owner_id" = r."owner_id" AND n."path" <@ r."path" AND n."id" <> root
         AND ((n."type" <> 'branch' AND nlevel(n."path") = lvl)
              OR (n."type" = 'branch' AND nlevel(n."path") = lvl + 1))
    ));
  END LOOP;
END
$$;
--> statement-breakpoint

-- Re-derive the folder rows of exactly these nodes from their direct
-- folders (set based).
-- Re-derive the folder rows of exactly these nodes from their direct
-- folders (set based), under the internal flag (its grant writes start no
-- second propagation: audit L9).
CREATE OR REPLACE FUNCTION "public"."mantle_rederive_nodes"(ids uuid[])
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  was text := coalesce(current_setting('mantle.acl_internal', true), '');
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  PERFORM set_config('mantle.acl_internal', 'on', true);

  -- Stale derived rows: the folder no longer gives that workspace (or the
  -- item left the folder).
  DELETE FROM "public"."item_grants" ig
   USING "public"."nodes" n
   LEFT JOIN "public"."nodes" f
     ON f."owner_id" = n."owner_id" AND f."type" = 'branch'
    AND f."path" = "public"."mantle_parent_folder_path"(n."type", n."path")
  WHERE n."id" = ANY (ids) AND ig."node_id" = n."id"
    AND ig."via_folder_id" IS NOT NULL AND NOT ig."is_home" AND NOT ig."excluded"
    AND NOT EXISTS (
      SELECT 1 FROM "public"."item_grants" fg
       WHERE fg."node_id" = f."id" AND fg."workspace_id" = ig."workspace_id"
         AND NOT fg."excluded"
         AND "public"."mantle_grant_kind_ok"(n."type", fg."workspace_id", true));

  -- Wanted derived rows: insert, or bring an existing derived row up to date.
  INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "write", "via_folder_id")
  SELECT n."id", fg."workspace_id", fg."write", f."id"
    FROM "public"."nodes" n
    JOIN "public"."nodes" f
      ON f."owner_id" = n."owner_id" AND f."type" = 'branch'
     AND f."path" = "public"."mantle_parent_folder_path"(n."type", n."path")
    JOIN "public"."item_grants" fg ON fg."node_id" = f."id" AND NOT fg."excluded"
   WHERE n."id" = ANY (ids)
     AND "public"."mantle_grant_kind_ok"(n."type", fg."workspace_id", true)
  ON CONFLICT ("node_id", "workspace_id") DO UPDATE
     SET "write" = EXCLUDED."write", "via_folder_id" = EXCLUDED."via_folder_id"
   WHERE "item_grants"."via_folder_id" IS NOT NULL
     AND NOT "item_grants"."is_home" AND NOT "item_grants"."excluded"
     AND ("item_grants"."write", "item_grants"."via_folder_id")
         IS DISTINCT FROM (EXCLUDED."write", EXCLUDED."via_folder_id");
  PERFORM set_config('mantle.acl_internal', was, true);
END
$$;
--> statement-breakpoint

-- A folder's own rows changed: lock the subtree's heads in rounds (U2, V1:
-- round 1 is the caller's mantle_lock_heads, later rounds NOWAIT) until no
-- new node appears, then re-derive below it.
CREATE OR REPLACE FUNCTION "public"."mantle_apply_folder_change"(folder uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  r record;
  ids uuid[];
  rounds int := 0;
BEGIN
  SELECT "owner_id", "path", "type" INTO r FROM "public"."nodes" WHERE "id" = folder;
  IF NOT FOUND OR r."type" <> 'branch' THEN RETURN; END IF;
  IF cardinality("public"."mantle_heads_held"()) > 0 THEN
    LOOP
      SELECT coalesce(array_agg(n."id" ORDER BY n."id"), '{}'::uuid[]) INTO ids
        FROM "public"."nodes" n
       WHERE n."owner_id" = r."owner_id" AND n."path" <@ r."path"
         AND NOT (n."id" = ANY ("public"."mantle_heads_held"()));
      EXIT WHEN cardinality(ids) = 0;
      rounds := rounds + 1;
      IF rounds > 5 THEN
        RAISE EXCEPTION 'mantle_apply_folder_change: subtree kept growing' USING ERRCODE = '40001';
      END IF;
      PERFORM "public"."mantle_lock_heads_more"(ids);
    END LOOP;
  ELSE
    PERFORM "public"."mantle_heads_miss"('folder_change', folder, 'folder grant changed without heads');
  END IF;
  PERFORM "public"."mantle_rederive_subtree"(folder, false);
END
$$;
--> statement-breakpoint

-- ── Triggers: item_grants ────────────────────────────────────────────────────

-- Keep the derived columns equal to the grants. Always runs, at any trigger
-- depth (test 3: the depth guard never skips this).
-- Keep the derived columns equal to the grants, at any depth (test 3). A
-- grant written outside the derivation needs the node's head FOR UPDATE
-- (audit M5); the derivation's own rows were locked by its caller's rounds.
CREATE OR REPLACE FUNCTION "public"."mantle_item_grants_refresh_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT "node_id") INTO ids FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT "node_id") INTO ids FROM old_rows;
  ELSE
    SELECT array_agg(DISTINCT x) INTO ids FROM (
      SELECT "node_id" AS x FROM new_rows UNION SELECT "node_id" FROM old_rows) s;
  END IF;
  IF NOT "public"."mantle_acl_internal"() THEN
    -- Only rows of nodes that still exist: a node delete cascades to its
    -- grants and never needs heads for that (V4).
    PERFORM "public"."mantle_heads_require"(
      ARRAY(SELECT n."id" FROM "public"."nodes" n WHERE n."id" = ANY (coalesce(ids, '{}'::uuid[]))),
      'item_grants_write', true);
  END IF;
  PERFORM "public"."mantle_acl_refresh"(ids);
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- Guards on single rows: kind rules and one home per item.
CREATE OR REPLACE FUNCTION "public"."mantle_item_grants_check_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  t "public"."node_type";
BEGIN
  SELECT "type" INTO t FROM "public"."nodes" WHERE "id" = NEW."node_id";
  IF NOT "public"."mantle_grant_kind_ok"(t, NEW."workspace_id") THEN
    RAISE EXCEPTION 'a % can be granted to the Admin workspace only', t USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Rows changed by hand (not by the derivation): re-derive the changed nodes
-- from their folders, and for a FOLDER propagate below it. Skipped when
-- called from inside another trigger (the derivation itself writes rows; it
-- never needs to start a second one).
CREATE OR REPLACE FUNCTION "public"."mantle_item_grants_propagate_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  ids uuid[];
  f uuid;
BEGIN
  -- The derivation's own rows never start a second derivation; a hand
  -- write at any depth (a cascade, another trigger) does (audit L9).
  IF "public"."mantle_acl_internal"() THEN RETURN NULL; END IF;
  -- Transition tables exist only for their event: branch on TG_OP so no
  -- statement names a table this event lacks.
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT "node_id") INTO ids FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT "node_id") INTO ids FROM old_rows;
  ELSE
    SELECT array_agg(DISTINCT x) INTO ids FROM (
      SELECT "node_id" AS x FROM new_rows UNION SELECT "node_id" FROM old_rows) s;
  END IF;
  -- The changed nodes themselves first: a hand row or an exclusion that
  -- went away lets the folder's row come back (idempotent otherwise).
  PERFORM "public"."mantle_rederive_nodes"(coalesce(ids, '{}'::uuid[]));
  FOR f IN
    SELECT n."id" FROM "public"."nodes" n
     WHERE n."id" = ANY (coalesce(ids, '{}'::uuid[])) AND n."type" = 'branch'
     ORDER BY n."id"
  LOOP
    PERFORM "public"."mantle_apply_folder_change"(f);
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "item_grants_check_trg" ON "public"."item_grants";
--> statement-breakpoint
CREATE TRIGGER "item_grants_check_trg"
  BEFORE INSERT OR UPDATE OF "workspace_id", "node_id" ON "public"."item_grants"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_item_grants_check_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "item_grants_refresh_ins" ON "public"."item_grants";
--> statement-breakpoint
CREATE TRIGGER "item_grants_refresh_ins" AFTER INSERT ON "public"."item_grants"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_item_grants_refresh_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "item_grants_refresh_upd" ON "public"."item_grants";
--> statement-breakpoint
CREATE TRIGGER "item_grants_refresh_upd" AFTER UPDATE ON "public"."item_grants"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_item_grants_refresh_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "item_grants_refresh_del" ON "public"."item_grants";
--> statement-breakpoint
CREATE TRIGGER "item_grants_refresh_del" AFTER DELETE ON "public"."item_grants"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_item_grants_refresh_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "item_grants_propagate_ins" ON "public"."item_grants";
--> statement-breakpoint
CREATE TRIGGER "item_grants_propagate_ins" AFTER INSERT ON "public"."item_grants"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_item_grants_propagate_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "item_grants_propagate_upd" ON "public"."item_grants";
--> statement-breakpoint
CREATE TRIGGER "item_grants_propagate_upd" AFTER UPDATE ON "public"."item_grants"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_item_grants_propagate_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "item_grants_propagate_del" ON "public"."item_grants";
--> statement-breakpoint
CREATE TRIGGER "item_grants_propagate_del" AFTER DELETE ON "public"."item_grants"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_item_grants_propagate_trg"();
--> statement-breakpoint

-- ── Triggers: nodes ──────────────────────────────────────────────────────────

-- A new node: check its folder's head is held (share or update), and start
-- its derived columns from the folder's rows (placing is accepting, S6).
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_acl_before_ins_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  f uuid;
BEGIN
  f := "public"."mantle_parent_folder"(NEW."owner_id", NEW."type", NEW."path");
  IF f IS NOT NULL THEN
    PERFORM "public"."mantle_heads_require"(ARRAY[f], 'nodes_insert');
    SELECT coalesce(array_agg(g."workspace_id" ORDER BY g."workspace_id"), '{}'::uuid[]),
           coalesce(array_agg(g."workspace_id" ORDER BY g."workspace_id") FILTER (WHERE g."write"), '{}'::uuid[])
      INTO NEW."read_ws", NEW."write_ws"
      FROM "public"."item_grants" g
     WHERE g."node_id" = f AND NOT g."excluded"
       AND "public"."mantle_grant_kind_ok"(NEW."type", g."workspace_id", true);
  ELSE
    NEW."read_ws" := '{}'::uuid[];
    NEW."write_ws" := '{}'::uuid[];
  END IF;
  -- Home rows are written by the app after the insert (W4 on); a new node
  -- starts without one.
  NEW."home_ws" := NULL;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- After the insert: the head row, and the folder's rows as derived grants.
-- Row level (no transition table: it would copy every inserted row,
-- embeddings included).
-- After the insert: the head row (counted as held: the node is this
-- transaction's own), and the folder's rows as derived grants. Row level
-- (no transition table: it would copy every inserted row, embeddings
-- included).
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_acl_after_ins_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  was text := coalesce(current_setting('mantle.acl_internal', true), '');
BEGIN
  INSERT INTO "public"."node_acl_head" ("node_id") VALUES (NEW."id")
    ON CONFLICT DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM "public"."nodes" f
      JOIN "public"."item_grants" g ON g."node_id" = f."id"
     WHERE f."owner_id" = NEW."owner_id" AND f."type" = 'branch'
       AND f."path" = "public"."mantle_parent_folder_path"(NEW."type", NEW."path")) THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('mantle.acl_internal', 'on', true);
  INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "write", "via_folder_id")
  SELECT NEW."id", g."workspace_id", g."write", f."id"
    FROM "public"."nodes" f
    JOIN "public"."item_grants" g ON g."node_id" = f."id" AND NOT g."excluded"
   WHERE f."owner_id" = NEW."owner_id" AND f."type" = 'branch'
     AND f."path" = "public"."mantle_parent_folder_path"(NEW."type", NEW."path")
     AND "public"."mantle_grant_kind_ok"(NEW."type", g."workspace_id", true)
  ON CONFLICT DO NOTHING;
  PERFORM set_config('mantle.acl_internal', was, true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- Only the derivation writes the derived columns (audit M4): a write of
-- read_ws, write_ws or home_ws by anyone else (a member-space update with
-- column privileges, an app bug) is refused. A change of login_id is
-- allowed and reaches the rows that follow the node.
-- SECURITY INVOKER on purpose: the guard must see the role that ran the
-- statement (mantle_acl_writer), not the owner.
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_acl_guard_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF NOT "public"."mantle_acl_writer"()
     AND (NEW."read_ws", NEW."write_ws", NEW."home_ws")
         IS DISTINCT FROM (OLD."read_ws", OLD."write_ws", OLD."home_ws") THEN
    RAISE EXCEPTION 'read_ws, write_ws and home_ws are derived from item_grants and cannot be written'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_login_follow_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  PERFORM "public"."mantle_acl_refresh"(ARRAY[NEW."id"]);
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- The same guard on the copies: their read_ws and login_id come from the
-- node, or (a fact learned from chat, no source node) from the app at insert.
CREATE OR REPLACE FUNCTION "public"."mantle_follow_guard_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF NOT "public"."mantle_acl_writer"()
     AND (NEW."read_ws", NEW."login_id") IS DISTINCT FROM (OLD."read_ws", OLD."login_id") THEN
    RAISE EXCEPTION 'read_ws and login_id of % follow their node and cannot be written', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- A moved row (its path changed) is noted in a session temp table; the
-- statement trigger below handles the whole statement once. Postgres allows
-- no column list on a trigger with transition tables, and a transition table
-- on every UPDATE of nodes would copy each saved row; this costs nothing for
-- an update that does not touch the path.
-- A moved row (its path changed) is noted in a session temp table; the
-- statement trigger below handles the whole statement once. Postgres allows
-- no column list on a trigger with transition tables, and a transition table
-- on every UPDATE of nodes would copy each saved row; this costs nothing for
-- an update that does not touch the path. The table must be this function's
-- own, with no trigger and no rule (audit M2: a table of that name made by
-- the session would otherwise run its code here as the definer).
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_moved_row_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  rel regclass := to_regclass('pg_temp.mantle_moved_nodes');
BEGIN
  IF rel IS NULL THEN
    CREATE TEMP TABLE "mantle_moved_nodes" ("id" uuid PRIMARY KEY) ON COMMIT DELETE ROWS;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = rel AND c.relowner = current_user::regrole AND c.relkind = 'r')
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = rel)
     OR EXISTS (SELECT 1 FROM pg_rewrite r WHERE r.ev_class = rel) THEN
    RAISE EXCEPTION 'mantle_moved_nodes is not the move trigger''s own table' USING ERRCODE = '42501';
  END IF;
  INSERT INTO pg_temp."mantle_moved_nodes" ("id") VALUES (NEW."id") ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- A path change (a move, or a folder rename that rewrites its subtree):
-- check the heads of the moved rows and their new folders, enforce the
-- placement rule for a user scope (S6, apps excepted), then re-derive each
-- moved root once (a deep ltree rewrite runs this once per statement).
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_acl_path_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  moved uuid[];
  roots uuid[];
  folders uuid[];
  m record;
  root uuid;
BEGIN
  IF to_regclass('pg_temp.mantle_moved_nodes') IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(array_agg("id"), '{}'::uuid[]) INTO moved FROM pg_temp."mantle_moved_nodes";
  DELETE FROM pg_temp."mantle_moved_nodes";
  IF cardinality(moved) = 0 THEN RETURN NULL; END IF;

  -- Roots: moved rows whose new folder did not move with them.
  SELECT coalesce(array_agg(n."id"), '{}'::uuid[]),
         coalesce(array_agg(DISTINCT pf."id") FILTER (WHERE pf."id" IS NOT NULL), '{}'::uuid[])
    INTO roots, folders
    FROM "public"."nodes" n
    LEFT JOIN "public"."nodes" pf
      ON pf."owner_id" = n."owner_id" AND pf."type" = 'branch'
     AND pf."path" = "public"."mantle_parent_folder_path"(n."type", n."path")
   WHERE n."id" = ANY (moved)
     AND (pf."id" IS NULL OR NOT (pf."id" = ANY (moved)));

  PERFORM "public"."mantle_heads_require"(moved, 'nodes_move', true);
  PERFORM "public"."mantle_heads_require"(folders, 'nodes_move_folder');

  IF "public"."mantle_scope_active"() THEN
    FOR m IN
      SELECT n."id", n."type", n."home_ws", n."read_ws", pf."id" AS folder,
             pf."home_ws" AS f_home, pf."write_ws" AS f_write, pf."read_ws" AS f_read
        FROM "public"."nodes" n
        LEFT JOIN "public"."nodes" pf
          ON pf."owner_id" = n."owner_id" AND pf."type" = 'branch'
         AND pf."path" = "public"."mantle_parent_folder_path"(n."type", n."path")
       WHERE n."id" = ANY (roots)
    LOOP
      IF NOT "public"."mantle_may_manage"(m."home_ws") THEN
        RAISE EXCEPTION 'not allowed to move this item' USING ERRCODE = '42501';
      END IF;
      IF m.folder IS NOT NULL AND NOT "public"."mantle_may_edit"(m.f_home, m.f_write) THEN
        RAISE EXCEPTION 'not allowed to add items to that folder' USING ERRCODE = '42501';
      END IF;
      -- Apps: a placement that adds a holder needs Moderator of each added
      -- workspace (the app exception to "placing is accepting").
      IF m."type" = 'app' AND m.folder IS NOT NULL
         AND EXISTS (SELECT 1 FROM unnest(m.f_read) AS w
                      WHERE NOT (w = ANY (m."read_ws"))
                        AND NOT (w = ANY ("public"."mantle_scope_mod_ws"()))) THEN
        RAISE EXCEPTION 'placing this app adds a workspace you do not moderate' USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END IF;

  FOREACH root IN ARRAY roots LOOP
    PERFORM "public"."mantle_rederive_subtree"(root, true);
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "nodes_acl_before_ins" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_acl_before_ins" BEFORE INSERT ON "public"."nodes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_nodes_acl_before_ins_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_acl_after_ins" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_acl_after_ins" AFTER INSERT ON "public"."nodes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_nodes_acl_after_ins_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_acl_moved_row" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_acl_moved_row" AFTER UPDATE OF "path" ON "public"."nodes"
  FOR EACH ROW WHEN (OLD."path"::text IS DISTINCT FROM NEW."path"::text)
  EXECUTE FUNCTION "public"."mantle_nodes_moved_row_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_acl_path" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_acl_path" AFTER UPDATE OF "path" ON "public"."nodes"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_nodes_acl_path_trg"();
--> statement-breakpoint

-- ── Triggers: rows that follow a node ────────────────────────────────────────

-- A new chunk, window or fact (or one re-pointed at another node) copies the
-- node's derived columns, after checking the node's head is held. The head
-- serializes it with any grant change on that node (R4 via U1). A fact whose
-- source goes NULL (ON DELETE SET NULL) is never checked and keeps its
-- read_ws (V4, R7: frozen, never wider).
CREATE OR REPLACE FUNCTION "public"."mantle_follow_node_acl_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  nid uuid;
BEGIN
  IF TG_TABLE_NAME = 'facts' THEN nid := NEW."source_node_id"; ELSE nid := NEW."node_id"; END IF;
  IF nid IS NULL THEN RETURN NEW; END IF;
  PERFORM "public"."mantle_heads_require"(ARRAY[nid], TG_TABLE_NAME || '_write', true);
  SELECT n."read_ws", n."login_id" INTO NEW."read_ws", NEW."login_id"
    FROM "public"."nodes" n WHERE n."id" = nid;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "content_chunks_acl_trg" ON "public"."content_chunks";
--> statement-breakpoint
CREATE TRIGGER "content_chunks_acl_trg"
  BEFORE INSERT OR UPDATE OF "node_id" ON "public"."content_chunks"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_follow_node_acl_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "content_chunk_windows_acl_trg" ON "public"."content_chunk_windows";
--> statement-breakpoint
CREATE TRIGGER "content_chunk_windows_acl_trg"
  BEFORE INSERT OR UPDATE OF "node_id" ON "public"."content_chunk_windows"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_follow_node_acl_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_acl_guard" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_acl_guard" BEFORE UPDATE OF "read_ws", "write_ws", "home_ws" ON "public"."nodes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_nodes_acl_guard_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_login_follow" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_login_follow" AFTER UPDATE OF "login_id" ON "public"."nodes"
  FOR EACH ROW WHEN (OLD."login_id" IS DISTINCT FROM NEW."login_id")
  EXECUTE FUNCTION "public"."mantle_nodes_login_follow_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "content_chunks_acl_guard" ON "public"."content_chunks";
--> statement-breakpoint
CREATE TRIGGER "content_chunks_acl_guard" BEFORE UPDATE OF "read_ws", "login_id" ON "public"."content_chunks"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_follow_guard_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "content_chunk_windows_acl_guard" ON "public"."content_chunk_windows";
--> statement-breakpoint
CREATE TRIGGER "content_chunk_windows_acl_guard" BEFORE UPDATE OF "read_ws", "login_id" ON "public"."content_chunk_windows"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_follow_guard_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "facts_acl_guard" ON "public"."facts";
--> statement-breakpoint
CREATE TRIGGER "facts_acl_guard" BEFORE UPDATE OF "read_ws", "login_id" ON "public"."facts"
  FOR EACH ROW WHEN (NEW."source_node_id" IS NOT NULL)
  EXECUTE FUNCTION "public"."mantle_follow_guard_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "facts_acl_trg" ON "public"."facts";
--> statement-breakpoint
CREATE TRIGGER "facts_acl_trg"
  BEFORE INSERT OR UPDATE OF "source_node_id" ON "public"."facts"
  FOR EACH ROW WHEN (NEW."source_node_id" IS NOT NULL)
  EXECUTE FUNCTION "public"."mantle_follow_node_acl_trg"();
--> statement-breakpoint

-- ── Assistants keep their workspace once they have history ───────────────────

CREATE OR REPLACE FUNCTION "public"."mantle_agent_has_history"(agent uuid)
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "public"."assistant_messages" m WHERE m."agent_id" = agent)
      OR EXISTS (SELECT 1 FROM "public"."chat_threads" t WHERE t."agent_id" = agent)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_agents_workspace_freeze_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF OLD."workspace_id" IS NOT NULL
     AND NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
     AND "public"."mantle_agent_has_history"(OLD."id") THEN
    RAISE EXCEPTION 'this assistant has history in its workspace: clone it to use it elsewhere'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agents_workspace_freeze_trg" ON "public"."agents";
--> statement-breakpoint
CREATE TRIGGER "agents_workspace_freeze_trg"
  BEFORE UPDATE OF "workspace_id" ON "public"."agents"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_agents_workspace_freeze_trg"();
--> statement-breakpoint

-- An assistant resource row must match the agent's workspace: the first
-- attach writes it, a later attach elsewhere is refused by the freeze above.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_assistant_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  agent uuid;
BEGIN
  IF NEW."type" <> 'assistant' THEN RETURN NEW; END IF;
  BEGIN
    agent := NEW."ref_id"::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'an assistant resource names an agent id' USING ERRCODE = '22P02';
  END;
  UPDATE "public"."agents" SET "workspace_id" = NEW."workspace_id"
   WHERE "id" = agent AND "workspace_id" IS DISTINCT FROM NEW."workspace_id";
  IF NOT EXISTS (SELECT 1 FROM "public"."agents" WHERE "id" = agent) THEN
    RAISE EXCEPTION 'no such agent' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workspace_resources_assistant_trg" ON "public"."workspace_resources";
--> statement-breakpoint
CREATE TRIGGER "workspace_resources_assistant_trg"
  BEFORE INSERT OR UPDATE OF "ref_id", "workspace_id", "type" ON "public"."workspace_resources"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_ws_assistant_trg"();
--> statement-breakpoint

-- ── Moderators ───────────────────────────────────────────────────────────────

-- The Admin workspace keeps at least one Moderator.
-- The Admin workspace keeps at least one Moderator. Checked at commit with
-- the workspace row locked, so two transactions that each remove a
-- different Moderator cannot both pass (audit L8: write skew).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_last_admin_mod_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  ws uuid := OLD."workspace_id";
  is_admin_ws boolean;
BEGIN
  SELECT w."is_admin" INTO is_admin_ws FROM "public"."workspaces" w WHERE w."id" = ws FOR UPDATE;
  IF coalesce(is_admin_ws, false)
     AND NOT EXISTS (SELECT 1 FROM "public"."workspace_users" u
                      WHERE u."workspace_id" = ws AND u."moderator") THEN
    RAISE EXCEPTION 'the Admin workspace needs at least one Moderator' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- Which workspace is the Admin workspace never changes after it is made
-- (audit L8: a flip would dodge the Moderator guard).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_admin_fixed_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF NEW."is_admin" IS DISTINCT FROM OLD."is_admin" THEN
    RAISE EXCEPTION 'is_admin is fixed when a workspace is made' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workspace_users_last_admin_mod" ON "public"."workspace_users";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "workspace_users_last_admin_mod"
  AFTER UPDATE OR DELETE ON "public"."workspace_users"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_ws_last_admin_mod_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workspaces_admin_fixed" ON "public"."workspaces";
--> statement-breakpoint
CREATE TRIGGER "workspaces_admin_fixed" BEFORE UPDATE OF "is_admin" ON "public"."workspaces"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_ws_admin_fixed_trg"();
--> statement-breakpoint

-- ── Who may call what (audit M1) ─────────────────────────────────────────────
-- The security definer helpers and trigger functions run only for the app
-- (the migrating role) and inside triggers. No limited role calls them, so
-- PUBLIC loses EXECUTE: a viewer connection cannot lock every head or write
-- the log.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND p.proname IN (
         'mantle_heads_check_mode', 'mantle_heads_sig', 'mantle_heads_held', 'mantle_heads_set',
         'mantle_heads_miss', 'mantle_heads_require', 'mantle_lock_heads', 'mantle_lock_heads_more',
         'mantle_lock_subtree_heads', 'mantle_acl_refresh',
         'mantle_rederive_subtree', 'mantle_rederive_nodes', 'mantle_apply_folder_change',
         'mantle_item_grants_refresh_trg', 'mantle_item_grants_check_trg',
         'mantle_item_grants_propagate_trg', 'mantle_nodes_acl_before_ins_trg',
         'mantle_nodes_acl_after_ins_trg', 'mantle_nodes_login_follow_trg',
         'mantle_nodes_moved_row_trg', 'mantle_nodes_acl_path_trg', 'mantle_follow_node_acl_trg',
         'mantle_agents_workspace_freeze_trg', 'mantle_ws_assistant_trg',
         'mantle_ws_last_admin_mod_trg', 'mantle_ws_admin_fixed_trg')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
END $$;
