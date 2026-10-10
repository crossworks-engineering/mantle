-- Workspaces, phase W4a: the workspaces go live as DATA (plan page 4887b8e7,
-- sections 9.1, 9.2, 9.4, 11, R3, R7, S1, T1, 21.8 and 21.9; the CEO's W4
-- decisions of 2026-10-10).
--
-- What this writes, once, on a brain without client logins or client items:
--  - the Admin workspace (every admin login, Moderator) and the Team
--    workspace (every admin and member login, all Moderators; Admin users
--    moderate it by admin_moderated);
--  - grants for every brain item by the 9.2 table: home Admin, plus Team
--    where the team role reads it today; an app the team reads is homed in
--    Team (T1). Every (item, Admin) and (item, Team) pair is DECIDED by a row
--    (granted, home, or "removed here"), so no folder passes a workspace the
--    level does not give;
--  - the persona assistant on Admin, the team responder on Team, every
--    connector on Admin (Write on) and the team-level ones on Team.
-- Personal-space items get no grants here (CEO, W4 decision 2): they keep
-- today's space rules until W6b moves them, and with them the assistant gains
-- of 9.4 rule 2. Snapshot copies (S3) are a hand-run task before W5b.
--
-- A brain WITH client logins or client-level items is not migrated (21.9:
-- clients are set up by hand). The migration then writes no workspace and
-- says so in a NOTICE; the bridges stay inert while there is no Admin
-- workspace, and /debug/integrity shows a warning.
--
-- The reach diff runs inside this transaction: if any login or assistant
-- would read an item it does not read today, the migration fails and
-- nothing is written (9.4).
--
-- The bridges (temporary, one way, removed in W5b): a level change made by
-- today's UI rewrites that item's bridge-owned rows by the same table, and a
-- login's role keeps its Admin and Team membership. The item bridge never
-- touches an item whose home is not bridge-owned, never rewrites a row that
-- is not bridge-owned, and adds Admin only as the HOME of a brain item that
-- an Admin user made in today's UI (CEO, 2026-10-10).
--
-- Facts with a source follow their node (EXISTS on nodes, like chunks since
-- 0249): a grant change writes no fact row. A node's delete freezes its
-- read_ws and login_id onto its facts first (BEFORE DELETE), so a fact whose
-- source is gone keeps its last access, never wider (R7). Facts learned in
-- chat (no source) keep their own copy; the ones already stored map to Admin.
--
-- Threads, messages, tool results, runs and traces gain workspace_id and
-- login_id (R3). A row's workspace is stamped from its agent at insert; NULL
-- means the Admin workspace (every row written before this release is from
-- the admin era). Only rows of agents attached elsewhere are backfilled.
--
-- No trigger here starts LLM work and nothing notifies the extractor. Grant
-- writes are arrays only. Apps, app data and app-db files are not touched:
-- only grant rows are written.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
SELECT "public"."mantle_heads_bypass"('0250_workspaces_live');
--> statement-breakpoint

-- ── Columns ──────────────────────────────────────────────────────────────────

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
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "public"."workspaces"("id") ON DELETE NO ACTION,
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."chat_threads"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "public"."workspaces"("id") ON DELETE NO ACTION,
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."tool_results"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "public"."workspaces"("id") ON DELETE NO ACTION,
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."runs"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "public"."workspaces"("id") ON DELETE NO ACTION,
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."run_items"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "public"."workspaces"("id") ON DELETE NO ACTION,
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."pending_tool_calls"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "public"."workspaces"("id") ON DELETE NO ACTION,
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."traces"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "public"."workspaces"("id") ON DELETE NO ACTION,
  ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint

-- ── R3: stamp the workspace at insert ───────────────────────────────────────
-- From the row's agent (its workspace once attached), or for a run item from
-- its run, for a tool result from its trace. A value the writer set wins.
-- A lookup by primary key per row: no LLM work, no notify.
CREATE OR REPLACE FUNCTION "public"."mantle_stamp_workspace_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  src record;
BEGIN
  IF NEW."workspace_id" IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'run_items' THEN
    SELECT r."workspace_id" AS ws, r."login_id" AS login INTO src
      FROM "public"."runs" r WHERE r."id" = NEW."run_id";
  ELSIF TG_TABLE_NAME = 'tool_results' THEN
    SELECT t."workspace_id" AS ws, t."login_id" AS login INTO src
      FROM "public"."traces" t WHERE t."id" = NEW."trace_id";
  ELSE
    SELECT a."workspace_id" AS ws, NULL::uuid AS login INTO src
      FROM "public"."agents" a WHERE a."id" = NEW."agent_id";
  END IF;
  IF FOUND THEN
    NEW."workspace_id" := src.ws;
    NEW."login_id" := coalesce(NEW."login_id", src.login);
  END IF;
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
--> statement-breakpoint

-- ── Facts with a source follow their node ────────────────────────────────────

-- The rule for mantle_view_user: a fact with a source is read when its node
-- is (the node's own rule applies inside the EXISTS: workspaces and login);
-- a fact without one (learned in chat, or whose source is gone) by its own
-- copy. The W2 rule for marked facts stays.
DROP POLICY IF EXISTS "facts_user_read" ON "public"."facts";
--> statement-breakpoint
CREATE POLICY "facts_user_read" ON "public"."facts" FOR SELECT
  TO mantle_view_user
  USING (
    (CASE WHEN "source_node_id" IS NOT NULL
          THEN EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "facts"."source_node_id")
          ELSE "read_ws" && (SELECT "public"."mantle_scope_ws"())
               AND ("login_id" IS NULL OR "login_id" = (SELECT "public"."mantle_login_id"()))
     END)
    AND (NOT "derived_mixed" OR (SELECT "public"."mantle_scope_has_admin"())));
--> statement-breakpoint

-- The copy on a fact: written at insert (the heads check stays, W1), never
-- by a grant change, and read only once the source is gone. Clearing the
-- source by hand freezes the source's current access onto the fact.
CREATE OR REPLACE FUNCTION "public"."mantle_facts_acl_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  src record;
BEGIN
  IF NEW."source_node_id" IS NOT NULL THEN
    PERFORM "public"."mantle_heads_require"(ARRAY[NEW."source_node_id"], 'facts_write', true);
    SELECT n."read_ws", n."login_id" INTO NEW."read_ws", NEW."login_id"
      FROM "public"."nodes" n WHERE n."id" = NEW."source_node_id";
    RETURN NEW;
  END IF;
  -- A fact learned in chat that the writer did not stamp: today's rule (chat
  -- facts are admin only) through the bridge, so the Admin workspace while
  -- the bridge runs. A writer in a workspace scope stamps its own (W4b).
  IF TG_OP = 'INSERT' THEN
    IF NEW."read_ws" = '{}'::uuid[] THEN
      SELECT coalesce(array_agg(w."id"), '{}'::uuid[]) INTO NEW."read_ws"
        FROM "public"."workspaces" w
       WHERE w."owner_id" = NEW."owner_id" AND w."bridge_key" = 'admin';
    END IF;
    RETURN NEW;
  END IF;
  -- An UPDATE that clears the source (by hand, or the SET NULL of a delete):
  -- take the source's access while it still exists. After a delete it is
  -- gone, and the BEFORE DELETE trigger on nodes already froze it here.
  IF TG_OP = 'UPDATE' AND OLD."source_node_id" IS NOT NULL THEN
    SELECT n."read_ws" AS r, n."login_id" AS l INTO src
      FROM "public"."nodes" n WHERE n."id" = OLD."source_node_id";
    IF FOUND THEN
      NEW."read_ws" := src.r;
      NEW."login_id" := src.l;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_facts_acl_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "facts_acl_trg" ON "public"."facts";
--> statement-breakpoint
CREATE TRIGGER "facts_acl_trg"
  BEFORE INSERT OR UPDATE OF "source_node_id" ON "public"."facts"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_facts_acl_trg"();
--> statement-breakpoint
-- The guard: only the derivation writes the copy, on any fact.
DROP TRIGGER IF EXISTS "facts_acl_guard" ON "public"."facts";
--> statement-breakpoint
CREATE TRIGGER "facts_acl_guard" BEFORE UPDATE OF "read_ws", "login_id" ON "public"."facts"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_follow_guard_trg"();
--> statement-breakpoint

-- R7: a node's delete freezes its access onto its facts, before the
-- foreign key sets their source to NULL. Only rows whose copy differs are
-- written.
CREATE OR REPLACE FUNCTION "public"."mantle_facts_freeze_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  was text := coalesce(current_setting('mantle.acl_internal', true), '');
BEGIN
  PERFORM set_config('mantle.acl_internal', 'on', true);
  UPDATE "public"."facts" f
     SET "read_ws" = OLD."read_ws", "login_id" = OLD."login_id"
   WHERE f."source_node_id" = OLD."id"
     AND (f."read_ws", f."login_id") IS DISTINCT FROM (OLD."read_ws", OLD."login_id");
  PERFORM set_config('mantle.acl_internal', was, true);
  RETURN OLD;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_facts_freeze_trg"() FROM PUBLIC;
--> statement-breakpoint
-- Named to run after the kind-aware reap (0059), which deletes the episodic
-- and factual facts of the source first: only the kept ones are written.
DROP TRIGGER IF EXISTS "nodes_zz_facts_freeze" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_zz_facts_freeze" BEFORE DELETE ON "public"."nodes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_facts_freeze_trg"();
--> statement-breakpoint

-- The derivation writes nodes only now: chunks, windows and facts read
-- their node.
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
  PERFORM set_config('mantle.acl_internal', was, true);
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_acl_refresh"(uuid[]) FROM PUBLIC;
--> statement-breakpoint

-- ── Derived rows carry the bridge mark of the folder row they come from ─────
-- So "the bridge rewrites only its own rows" holds for rows a folder passed
-- on as well. Otherwise as 0241 and 0244.

CREATE OR REPLACE FUNCTION "public"."mantle_rederive_nodes"(ids uuid[])
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  was text := coalesce(current_setting('mantle.acl_internal', true), '');
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  PERFORM set_config('mantle.acl_internal', 'on', true);

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

  INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "write", "via_folder_id", "bridge")
  SELECT n."id", fg."workspace_id", fg."write", f."id", fg."bridge"
    FROM "public"."nodes" n
    JOIN "public"."nodes" f
      ON f."owner_id" = n."owner_id" AND f."type" = 'branch'
     AND f."path" = "public"."mantle_parent_folder_path"(n."type", n."path")
    JOIN "public"."item_grants" fg ON fg."node_id" = f."id" AND NOT fg."excluded"
   WHERE n."id" = ANY (ids)
     AND "public"."mantle_grant_kind_ok"(n."type", fg."workspace_id", true)
  ON CONFLICT ("node_id", "workspace_id") DO UPDATE
     SET "write" = EXCLUDED."write", "via_folder_id" = EXCLUDED."via_folder_id",
         "bridge" = EXCLUDED."bridge"
   WHERE "item_grants"."via_folder_id" IS NOT NULL
     AND NOT "item_grants"."is_home" AND NOT "item_grants"."excluded"
     AND ("item_grants"."write", "item_grants"."via_folder_id", "item_grants"."bridge")
         IS DISTINCT FROM (EXCLUDED."write", EXCLUDED."via_folder_id", EXCLUDED."bridge");
  PERFORM set_config('mantle.acl_internal', was, true);
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_rederive_nodes"(uuid[]) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_nodes_acl_after_ins_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  was text := coalesce(current_setting('mantle.acl_internal', true), '');
  held uuid[];
BEGIN
  INSERT INTO "public"."node_acl_head" ("node_id") VALUES (NEW."id")
    ON CONFLICT DO NOTHING;
  IF NEW."type" = 'branch' THEN
    held := "public"."mantle_heads_held"();
    IF cardinality(held) > 0 THEN
      PERFORM "public"."mantle_heads_set"(held || NEW."id",
                                           "public"."mantle_heads_held"(true) || NEW."id");
    END IF;
  END IF;
  -- While the bridge runs, a brain item's pairs are all decided by it (its
  -- statement trigger below), so the folder's rows are not copied first.
  IF EXISTS (SELECT 1 FROM "public"."workspaces" w
              WHERE w."owner_id" = NEW."owner_id" AND w."bridge_key" = 'admin') THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "public"."nodes" f
      JOIN "public"."item_grants" g ON g."node_id" = f."id"
     WHERE f."owner_id" = NEW."owner_id" AND f."type" = 'branch'
       AND f."path" = "public"."mantle_parent_folder_path"(NEW."type", NEW."path")) THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('mantle.acl_internal', 'on', true);
  INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "write", "via_folder_id", "bridge")
  SELECT NEW."id", g."workspace_id", g."write", f."id", g."bridge"
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
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_acl_after_ins_trg"() FROM PUBLIC;
--> statement-breakpoint

-- ── The item bridge (levels to grants, one way, until W5b) ───────────────────

-- The rows the 9.2 table wants for brain items `ids`: home Admin (or Team for
-- an app the team reads, T1), Team granted where the team role reads the
-- item today, else Team "removed here", so a folder never passes Team on.
-- Admin-only and conversation kinds get their home only (a folder never
-- passes them anything). Items whose home is not bridge-owned are left out,
-- and so is every personal-space item (its owner is not the brain).
CREATE OR REPLACE FUNCTION "public"."mantle_bridge_wanted"(ids uuid[])
  RETURNS TABLE ("node_id" uuid, "workspace_id" uuid, "write" boolean,
                 "is_home" boolean, "excluded" boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH ws AS (
    SELECT (SELECT w."id" FROM "public"."workspaces" w
             WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'admin') AS admin_ws,
           (SELECT w."id" FROM "public"."workspaces" w
             WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'team') AS team_ws
  ), n AS (
    SELECT x."id", "public"."mantle_kind_class"(x."type") AS kc, x."type" = 'app' AS is_app,
           "public"."mantle_team_reads"(x."type", x."audience", x."inherited_level",
             CASE WHEN x."type" = 'app' THEN NULL ELSE x."embedded_level" END) AS team,
           x."type" = 'app' AND NOT coalesce(a."data_read_only", false) AS app_write
      FROM "public"."nodes" x
      LEFT JOIN "public"."apps" a ON a."node_id" = x."id"
     WHERE x."id" = ANY (ids)
       AND x."owner_id" = "public"."mantle_brain_id"()
       AND NOT EXISTS (SELECT 1 FROM "public"."item_grants" h
                        WHERE h."node_id" = x."id" AND h."is_home" AND NOT h."bridge")
  )
  -- Admin: the home, except for an app the team reads ("removed here").
  SELECT n."id", ws.admin_ws, false, NOT (n.is_app AND n.team), n.is_app AND n.team
    FROM n, ws WHERE ws.admin_ws IS NOT NULL
  UNION ALL
  -- Team: for the workspace kinds only.
  SELECT n."id", ws.team_ws,
         n.team AND n.is_app AND n.app_write,
         n.team AND n.is_app,
         NOT n.team
    FROM n, ws
   WHERE ws.admin_ws IS NOT NULL AND ws.team_ws IS NOT NULL AND n.kc = 'workspace'
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_wanted"(uuid[]) FROM PUBLIC;
--> statement-breakpoint

-- Bring the bridge-owned rows of `ids` to what mantle_bridge_wanted says.
-- Rows that are not bridge-owned are never written. Under the internal flag:
-- every pair the bridge owns is decided, so nothing needs propagating, and
-- the writer that changed the level holds the item's head (W1).
CREATE OR REPLACE FUNCTION "public"."mantle_bridge_apply"(ids uuid[])
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  was text := coalesce(current_setting('mantle.acl_internal', true), '');
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM "public"."workspaces" w
                  WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'admin') THEN
    RETURN; -- not migrated: inert
  END IF;
  PERFORM set_config('mantle.acl_internal', 'on', true);
  -- No temporary table: this runs for every new node, and a temporary table
  -- per transaction churns the catalog. The wanted rows are recomputed per
  -- statement; the bridge's own writes never change them.

  -- Bridge rows of these items the table no longer wants.
  DELETE FROM "public"."item_grants" g
   WHERE g."node_id" = ANY (ids) AND g."bridge"
     AND EXISTS (SELECT 1 FROM "public"."mantle_bridge_wanted"(ARRAY[g."node_id"]) w0)
     AND NOT EXISTS (SELECT 1 FROM "public"."mantle_bridge_wanted"(ARRAY[g."node_id"]) w
                      WHERE w."workspace_id" = g."workspace_id");
  -- A home that moves: the old home row lets go first (one home per item).
  UPDATE "public"."item_grants" g SET "is_home" = false
    FROM "public"."mantle_bridge_wanted"(ids) w
   WHERE g."node_id" = w."node_id" AND g."workspace_id" = w."workspace_id"
     AND g."bridge" AND g."is_home" AND NOT w."is_home";
  -- The wanted rows: new, or a bridge row brought up to date. A pair that
  -- holds a row the bridge does not own is left alone.
  INSERT INTO "public"."item_grants"
    ("node_id", "workspace_id", "write", "is_home", "excluded", "via_folder_id", "bridge")
  SELECT w."node_id", w."workspace_id", w."write", w."is_home", w."excluded", NULL, true
    FROM "public"."mantle_bridge_wanted"(ids) w
  ON CONFLICT ("node_id", "workspace_id") DO UPDATE
     SET "write" = EXCLUDED."write", "is_home" = EXCLUDED."is_home",
         "excluded" = EXCLUDED."excluded", "via_folder_id" = NULL
   WHERE "item_grants"."bridge"
     AND ("item_grants"."write", "item_grants"."is_home", "item_grants"."excluded",
          "item_grants"."via_folder_id" IS NULL)
         IS DISTINCT FROM (EXCLUDED."write", EXCLUDED."is_home", EXCLUDED."excluded", true);
  PERFORM set_config('mantle.acl_internal', was, true);
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_apply"(uuid[]) FROM PUBLIC;
--> statement-breakpoint

-- The bridge's triggers. Inserts: a BEFORE row trigger fills the new row's
-- derived columns with what the bridge will grant (so the grant writes find
-- them equal and the node row is written once), then ONE statement trigger
-- writes the rows of every node the statement made. Level changes: a row
-- trigger lists the node for this transaction, a statement trigger applies
-- the list (one pass per statement, also for a folder share that changes
-- thousands of inherited levels).
CREATE UNLOGGED TABLE IF NOT EXISTS "public"."mantle_bridge_pending" (
  "xid" xid8 NOT NULL,
  "id" uuid NOT NULL,
  PRIMARY KEY ("xid", "id")
);
--> statement-breakpoint
ALTER TABLE "public"."mantle_bridge_pending" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_bridge_before_ins_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  a uuid;
  t uuid;
  team boolean;
BEGIN
  SELECT w."id" INTO a FROM "public"."workspaces" w
   WHERE w."owner_id" = NEW."owner_id" AND w."bridge_key" = 'admin';
  IF a IS NULL OR NEW."owner_id" IS DISTINCT FROM "public"."mantle_brain_id"() THEN RETURN NEW; END IF;
  SELECT w."id" INTO t FROM "public"."workspaces" w
   WHERE w."owner_id" = NEW."owner_id" AND w."bridge_key" = 'team';
  team := t IS NOT NULL AND "public"."mantle_kind_class"(NEW."type") = 'workspace'
          AND "public"."mantle_team_reads"(NEW."type", NEW."audience", NEW."inherited_level",
                CASE WHEN NEW."type" = 'app' THEN NULL ELSE NEW."embedded_level" END);
  IF NEW."type" = 'app' AND team THEN
    -- T1; a new app has no apps row yet, so its data is writable (the apps
    -- trigger corrects Write when the row comes).
    NEW."home_ws" := t;
    NEW."read_ws" := ARRAY[t];
    NEW."write_ws" := ARRAY[t];
  ELSE
    NEW."home_ws" := a;
    NEW."read_ws" := CASE WHEN team THEN ARRAY(SELECT x FROM unnest(ARRAY[a, t]) x ORDER BY x)
                          ELSE ARRAY[a] END;
    NEW."write_ws" := '{}'::uuid[];
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_before_ins_trg"() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_bridge_ins_stmt_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  PERFORM "public"."mantle_bridge_apply"(ARRAY(
    SELECT r."id" FROM new_rows r WHERE r."owner_id" = "public"."mantle_brain_id"()));
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_ins_stmt_trg"() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_bridge_upd_row_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  INSERT INTO "public"."mantle_bridge_pending" ("xid", "id")
  VALUES (pg_current_xact_id(), NEW."id") ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_upd_row_trg"() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_bridge_upd_stmt_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  me xid8 := pg_current_xact_id_if_assigned();
  ids uuid[];
BEGIN
  IF me IS NULL THEN RETURN NULL; END IF;
  WITH taken AS (
    DELETE FROM "public"."mantle_bridge_pending" p WHERE p."xid" = me RETURNING p."id")
  SELECT array_agg(t."id") INTO ids FROM taken t;
  PERFORM "public"."mantle_bridge_apply"(ids);
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_upd_stmt_trg"() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_bridge_app_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  PERFORM "public"."mantle_bridge_apply"(ARRAY[NEW."node_id"]);
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_app_trg"() FROM PUBLIC;
--> statement-breakpoint

-- Names sort after the W1 triggers (nodes_acl_*): the bridge has the last word.
DROP TRIGGER IF EXISTS "nodes_zz_bridge_before" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_zz_bridge_before" BEFORE INSERT ON "public"."nodes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_bridge_before_ins_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_zz_bridge_ins" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_zz_bridge_ins" AFTER INSERT ON "public"."nodes"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_bridge_ins_stmt_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_zz_bridge_upd" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_zz_bridge_upd"
  AFTER UPDATE OF "audience", "inherited_level", "embedded_level", "owner_id" ON "public"."nodes"
  FOR EACH ROW
  WHEN (OLD."audience" IS DISTINCT FROM NEW."audience"
        OR OLD."inherited_level" IS DISTINCT FROM NEW."inherited_level"
        OR OLD."embedded_level" IS DISTINCT FROM NEW."embedded_level"
        OR OLD."owner_id" IS DISTINCT FROM NEW."owner_id")
  EXECUTE FUNCTION "public"."mantle_bridge_upd_row_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_zz_bridge_upd_stmt" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_zz_bridge_upd_stmt"
  AFTER UPDATE OF "audience", "inherited_level", "embedded_level", "owner_id" ON "public"."nodes"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_bridge_upd_stmt_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "apps_zz_bridge" ON "public"."apps";
--> statement-breakpoint
CREATE TRIGGER "apps_zz_bridge" AFTER INSERT OR UPDATE OF "data_read_only" ON "public"."apps"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_bridge_app_trg"();
--> statement-breakpoint

-- Drift between levels and bridge rows (the workspaces check, hand-run and in
-- /debug/integrity): brain items whose bridge-owned pairs differ from what
-- the table wants. Numbers only.
CREATE OR REPLACE FUNCTION "public"."mantle_bridge_drift"()
  RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH w AS (
    SELECT * FROM "public"."mantle_bridge_wanted"(ARRAY(
      SELECT n."id" FROM "public"."nodes" n WHERE n."owner_id" = "public"."mantle_brain_id"()))
  ), g AS (
    SELECT ig."node_id", ig."workspace_id", ig."write", ig."is_home", ig."excluded"
      FROM "public"."item_grants" ig
     WHERE ig."bridge" AND ig."node_id" IN (SELECT w."node_id" FROM w)
  )
  SELECT count(DISTINCT x."node_id") FROM (
    (SELECT * FROM w EXCEPT SELECT * FROM g)
    UNION ALL
    (SELECT * FROM g EXCEPT SELECT * FROM w)
  ) x
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_drift"() FROM PUBLIC;
--> statement-breakpoint

-- ── The login bridge (role to Admin and Team membership, until W5a) ──────────
-- admin: Moderator of Admin and Team; member: Moderator of Team (Q1, 9.1,
-- disabled logins too: they cannot sign in); client or anything else: in
-- neither. Only the two bridge workspaces are touched. Each change is logged.
CREATE OR REPLACE FUNCTION "public"."mantle_bridge_login"(login uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  admin_ws uuid;
  team_ws uuid;
  r text;
  changed int;
  gone int;
BEGIN
  SELECT w."id" INTO admin_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'admin';
  SELECT w."id" INTO team_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'team';
  IF admin_ws IS NULL THEN RETURN; END IF;
  SELECT u."role" INTO r FROM auth.users u WHERE u."id" = login;
  -- Into the workspaces the role gives (Moderator in each).
  INSERT INTO "public"."workspace_users" ("workspace_id", "login_id", "moderator")
  SELECT x.ws, login, true
    FROM (VALUES (admin_ws, r = 'admin'), (team_ws, r IN ('admin', 'member'))) AS x(ws, want)
   WHERE x.ws IS NOT NULL AND coalesce(x.want, false)
  ON CONFLICT ("workspace_id", "login_id") DO UPDATE SET "moderator" = true
   WHERE NOT "workspace_users"."moderator";
  GET DIAGNOSTICS changed = ROW_COUNT;
  -- Out of the ones it no longer gives.
  DELETE FROM "public"."workspace_users" u
   WHERE u."login_id" = login
     AND ((u."workspace_id" = admin_ws AND coalesce(r, '') <> 'admin')
          OR (u."workspace_id" = team_ws AND coalesce(r, '') NOT IN ('admin', 'member')));
  GET DIAGNOSTICS gone = ROW_COUNT;
  IF changed + gone > 0 THEN
    INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
    VALUES (admin_ws, NULL, 'bridge.login', jsonb_build_object('login', login, 'role', r));
  END IF;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_login"(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_bridge_login_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  PERFORM "public"."mantle_bridge_login"(NEW."id");
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_login_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_zz_bridge" ON auth.users;
--> statement-breakpoint
CREATE TRIGGER "users_zz_bridge" AFTER INSERT OR UPDATE OF "role" ON auth.users
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_bridge_login_trg"();
--> statement-breakpoint

-- ── The reach diff (9.4), on the live tables ─────────────────────────────────
-- OLD: what each login and the two assistants read in the brain today (the
-- personal spaces are not part of this release: they keep their own rules).
-- NEW: the brain items whose read_ws meets their workspaces. A gain is a
-- 'reach-fail' row. Numbers only.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_reach_diff"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp SET client_min_messages = warning AS $$
#variable_conflict use_column
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  admin_ws uuid;
  team_ws uuid;
BEGIN
  SELECT w."id" INTO admin_ws FROM "public"."workspaces" w WHERE w."owner_id" = brain AND w."bridge_key" = 'admin';
  SELECT w."id" INTO team_ws FROM "public"."workspaces" w WHERE w."owner_id" = brain AND w."bridge_key" = 'team';
  CREATE TEMP TABLE IF NOT EXISTS _wsr_old (subject text, node_id uuid, PRIMARY KEY (subject, node_id)) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _wsr_new (subject text, node_id uuid, PRIMARY KEY (subject, node_id)) ON COMMIT DROP;
  DELETE FROM _wsr_old;
  DELETE FROM _wsr_new;
  INSERT INTO _wsr_old
    SELECT 'login:' || u.id, n.id FROM auth.users u JOIN "public"."nodes" n ON n.owner_id = brain
     WHERE u.role = 'admin';
  INSERT INTO _wsr_old
    SELECT 'login:' || u.id, n.id FROM auth.users u JOIN "public"."nodes" n ON n.owner_id = brain
     WHERE u.role = 'member'
       AND "public"."mantle_team_reads"(n.type, n.audience, n.inherited_level, n.embedded_level);
  INSERT INTO _wsr_old SELECT 'assistant:admin', n.id FROM "public"."nodes" n WHERE n.owner_id = brain;
  INSERT INTO _wsr_old
    SELECT 'assistant:team', n.id FROM "public"."nodes" n
     WHERE n.owner_id = brain
       AND "public"."mantle_team_reads"(n.type, n.audience, n.inherited_level, n.embedded_level);

  INSERT INTO _wsr_new
    SELECT DISTINCT 'login:' || wu.login_id, n.id
      FROM "public"."workspace_users" wu
      JOIN "public"."nodes" n ON n.owner_id = brain AND n.read_ws @> ARRAY[wu.workspace_id]
    ON CONFLICT DO NOTHING;
  INSERT INTO _wsr_new
    SELECT 'assistant:admin', n.id FROM "public"."nodes" n
     WHERE n.owner_id = brain AND admin_ws IS NOT NULL AND n.read_ws @> ARRAY[admin_ws];
  INSERT INTO _wsr_new
    SELECT 'assistant:team', n.id FROM "public"."nodes" n
     WHERE n.owner_id = brain AND team_ws IS NOT NULL AND n.read_ws @> ARRAY[team_ws];

  RETURN QUERY
    SELECT 'reach-fail', CASE WHEN nw.subject LIKE 'login:%'
                              THEN 'login (' || coalesce(u.role, 'gone') || ')' ELSE nw.subject END,
           'gained items', count(*)
      FROM _wsr_new nw
      LEFT JOIN auth.users u ON 'login:' || u.id = nw.subject
     WHERE NOT EXISTS (SELECT 1 FROM _wsr_old o WHERE o.subject = nw.subject AND o.node_id = nw.node_id)
     GROUP BY 2;
  RETURN QUERY
    SELECT 'reach', CASE WHEN o.subject LIKE 'login:%'
                         THEN 'login (' || coalesce(u.role, 'gone') || ')' ELSE o.subject END,
           'lost items (narrower, allowed)', count(*)
      FROM _wsr_old o
      LEFT JOIN auth.users u ON 'login:' || u.id = o.subject
     WHERE NOT EXISTS (SELECT 1 FROM _wsr_new nw WHERE nw.subject = o.subject AND nw.node_id = o.node_id)
     GROUP BY 2;
  RETURN QUERY
    SELECT 'reach', split_part(s.subject, ':', 1), 'subjects', count(*)
      FROM (SELECT DISTINCT subject FROM _wsr_new) s GROUP BY 2;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_reach_diff"() FROM PUBLIC;
--> statement-breakpoint

-- ── The migration itself ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "public"."mantle_ws_migrate"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  admin_ws uuid;
  team_ws uuid;
  clients bigint;
  client_items bigint;
  persona uuid;
  fails bigint;
BEGIN
  IF brain IS NULL THEN
    RETURN QUERY SELECT 'skip'::text, 'brain'::text, 'no brain anchor'::text, 1::bigint;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM "public"."workspaces" w WHERE w."owner_id" = brain AND w."bridge_key" = 'admin') THEN
    RETURN QUERY SELECT 'skip'::text, 'workspaces'::text, 'already migrated'::text, 1::bigint;
    RETURN;
  END IF;
  -- 21.9: clients are set up by hand, never migrated.
  SELECT count(*) INTO clients FROM auth.users u WHERE u."role" = 'client';
  SELECT count(*) INTO client_items FROM "public"."nodes" n
   WHERE n."owner_id" = brain
     AND (n."audience" = 'client' OR n."inherited_level" = 'client' OR n."embedded_level" = 'client');
  IF clients > 0 OR client_items > 0 THEN
    RAISE NOTICE 'workspaces not migrated: % client login(s), % client-level item(s); set them up by hand',
      clients, client_items;
    RETURN QUERY SELECT 'skip'::text, 'client logins'::text, 'count'::text, clients;
    RETURN QUERY SELECT 'skip'::text, 'client-level items'::text, 'count'::text, client_items;
    RETURN;
  END IF;

  -- Workspaces.
  INSERT INTO "public"."workspaces" ("owner_id", "name", "description", "is_admin", "bridge_key")
  VALUES (brain, 'Admin', 'Brain management, and everything made before workspaces.', true, 'admin')
  RETURNING "id" INTO admin_ws;
  INSERT INTO "public"."workspaces" ("owner_id", "name", "description", "admin_moderated", "bridge_key")
  VALUES (brain, 'Team', 'Work shared with the whole team.', true, 'team')
  RETURNING "id" INTO team_ws;

  -- Users (the login bridge, once per login).
  PERFORM "public"."mantle_bridge_login"(u."id") FROM auth.users u WHERE u."role" IN ('admin', 'member');

  -- Grants for every brain item.
  PERFORM "public"."mantle_bridge_apply"(ARRAY(
    SELECT n."id" FROM "public"."nodes" n WHERE n."owner_id" = brain));

  -- Facts learned in chat: admin only today, so Admin.
  PERFORM set_config('mantle.acl_internal', 'on', true);
  UPDATE "public"."facts" f SET "read_ws" = ARRAY[admin_ws]
   WHERE f."source_node_id" IS NULL AND f."owner_id" = brain AND f."read_ws" = '{}'::uuid[];
  PERFORM set_config('mantle.acl_internal', '', true);

  -- Assistants: the persona (the enabled admin-level responder, highest
  -- priority, a shared one before a login's own) on Admin; the team
  -- responder on Team. No Client workspace, so the client responder stays
  -- unattached.
  SELECT a."id" INTO persona FROM "public"."agents" a
   WHERE a."owner_id" = brain AND a."role" = 'responder' AND a."audience" = 'admin' AND a."enabled"
   ORDER BY a."priority" DESC, a."assigned_user_id" IS NOT NULL, a."created_at"
   LIMIT 1;
  IF persona IS NOT NULL THEN
    INSERT INTO "public"."workspace_resources" ("workspace_id", "type", "ref_id", "write")
    VALUES (admin_ws, 'assistant', persona::text, true);
  END IF;
  INSERT INTO "public"."workspace_resources" ("workspace_id", "type", "ref_id", "write")
  SELECT team_ws, 'assistant', a."id"::text, true
    FROM "public"."agents" a
   WHERE a."owner_id" = brain AND a."slug" = 'team-responder' AND a."audience" = 'team'
   LIMIT 1;

  -- Connectors (a tool group with an integration binding): every one on
  -- Admin with Write on (the owner's turns write today); the ones at team
  -- level or below also on Team, Write on (an app run by a member may write
  -- through them today; the read-only marks still apply per tool).
  INSERT INTO "public"."workspace_resources" ("workspace_id", "type", "ref_id", "write")
  SELECT admin_ws, 'connector', g."slug", true
    FROM "public"."tool_groups" g
   WHERE g."owner_id" = brain AND g."integration" IS NOT NULL;
  INSERT INTO "public"."workspace_resources" ("workspace_id", "type", "ref_id", "write")
  SELECT team_ws, 'connector', g."slug", true
    FROM "public"."tool_groups" g
   WHERE g."owner_id" = brain AND g."integration" IS NOT NULL
     AND g."audience" IN ('team', 'client', 'public');

  -- R3 backfill: only rows of agents attached outside Admin (NULL = Admin).
  UPDATE "public"."assistant_messages" m SET "workspace_id" = a."workspace_id"
    FROM "public"."agents" a WHERE a."id" = m."agent_id" AND a."workspace_id" = team_ws;
  UPDATE "public"."chat_threads" m SET "workspace_id" = a."workspace_id"
    FROM "public"."agents" a WHERE a."id" = m."agent_id" AND a."workspace_id" = team_ws;
  UPDATE "public"."runs" m SET "workspace_id" = a."workspace_id"
    FROM "public"."agents" a WHERE a."id" = m."agent_id" AND a."workspace_id" = team_ws;
  UPDATE "public"."run_items" i SET "workspace_id" = r."workspace_id"
    FROM "public"."runs" r WHERE r."id" = i."run_id" AND r."workspace_id" = team_ws;
  UPDATE "public"."pending_tool_calls" m SET "workspace_id" = a."workspace_id"
    FROM "public"."agents" a WHERE a."id" = m."agent_id" AND a."workspace_id" = team_ws;
  UPDATE "public"."traces" m SET "workspace_id" = a."workspace_id"
    FROM "public"."agents" a WHERE a."id" = m."agent_id" AND a."workspace_id" = team_ws;
  UPDATE "public"."tool_results" m SET "workspace_id" = t."workspace_id"
    FROM "public"."traces" t WHERE t."id" = m."trace_id" AND t."workspace_id" = team_ws;

  -- The proof (9.4): nobody reads more than today, or nothing is written.
  SELECT coalesce(sum(d."n"), 0) INTO fails
    FROM "public"."mantle_ws_reach_diff"() d WHERE d."section" = 'reach-fail';
  IF fails > 0 THEN
    RAISE EXCEPTION 'workspaces migration: % item read(s) would be gained (reach diff); nothing written', fails
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY SELECT 'done', 'workspaces', 'count', count(*)
    FROM "public"."workspaces" w WHERE w."owner_id" = brain;
  RETURN QUERY SELECT 'done', 'workspace users', 'count', count(*) FROM "public"."workspace_users";
  RETURN QUERY
    SELECT 'done', 'grants to ' || w."name" ||
             CASE WHEN g."is_home" THEN ' (home)' WHEN g."excluded" THEN ' (removed here)' ELSE '' END,
           'count', count(*)
      FROM "public"."item_grants" g JOIN "public"."workspaces" w ON w."id" = g."workspace_id"
     GROUP BY 2;
  RETURN QUERY SELECT 'done', 'resources ' || r."type", 'count', count(*)
    FROM "public"."workspace_resources" r GROUP BY 2;
  RETURN QUERY
    SELECT 'done', 'admin responders left unattached', 'count', count(*)
      FROM "public"."agents" a
     WHERE a."owner_id" = brain AND a."role" = 'responder' AND a."audience" = 'admin'
       AND a."workspace_id" IS NULL;
  RETURN QUERY SELECT * FROM "public"."mantle_ws_reach_diff"() d WHERE d."section" <> 'reach-fail';
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_migrate"() FROM PUBLIC;
--> statement-breakpoint

SELECT * FROM "public"."mantle_ws_migrate"();
