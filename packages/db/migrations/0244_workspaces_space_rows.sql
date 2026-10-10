-- Workspaces, phase W1b: personal-space rows and the heads check, and a
-- change of owner is a move (plan U1, V5, S6).
--
-- 1. Rows a member's personal space owns need no heads. The space role
--    cannot take heads (0241 revokes EXECUTE on the lock functions from
--    PUBLIC, so a limited role cannot lock brain heads), and no workspace
--    reads a personal row: item_grants refuses one (rule 2). So no grant
--    change can race a write there, and the check stays exact for brain
--    rows. Personal spaces and their role go in W6b. W4, which grants
--    personal items, must replace rule 1 and rule 2 together (a lock the
--    space role may take on its own rows) BEFORE it writes such a grant.
-- 2. item_grants refuses a node a personal space owns.
-- 3. A change of owner_id is a move. An item accepted from a personal space
--    into the brain lands in a brain folder and takes that folder's rows
--    (S6, placing is accepting), and its heads are checked like any move.
--    0241 fired the move triggers on a path change only.
-- 4. A folder made in a transaction that holds heads counts as held by it
--    (its head is the transaction's own), so an item moved into a folder
--    made in the same transaction passes the move check.
-- 5. The named bypass for migrations (plan V5): a migration that writes
--    nodes, chunks, windows, facts or grants in bulk calls
--    SELECT mantle_heads_bypass('<its name>'); first. Only the owner role may
--    call it (no grant to anyone else); it turns the check off for that
--    transaction alone, writes one log row (heads_check_misses, check
--    'bypass'), and the migration runner prints the name. A session cannot
--    forge it: the setting is signed with the heads key.
--
-- No trigger here starts LLM work: these are checks and the existing
-- re-derivation (arrays only).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

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
  -- The held list once, a set difference (as 0241 does), then rule 1.
  held := "public"."mantle_heads_held"(need_update);
  SELECT d.x INTO missing
    FROM (SELECT u.x FROM unnest(ids) AS u(x) WHERE u.x IS NOT NULL
          EXCEPT
          SELECT h.x FROM unnest(held) AS h(x)) d
   -- Rule 1: a row a personal space owns needs no heads.
   WHERE NOT EXISTS (SELECT 1 FROM "public"."nodes" n
                       JOIN "public"."spaces" s ON s."id" = n."owner_id"
                      WHERE n."id" = d.x AND s."kind" = 'personal')
   LIMIT 1;
  IF missing IS NOT NULL THEN
    PERFORM "public"."mantle_heads_miss"(check_name, missing,
      CASE WHEN need_update THEN 'head not locked first for update' ELSE 'head not locked first' END);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_heads_require"(uuid[], text, boolean) FROM PUBLIC;
--> statement-breakpoint

-- Rule 2: no grant on a personal-space row (until W4 replaces rules 1 and 2).
CREATE OR REPLACE FUNCTION "public"."mantle_item_grants_check_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  t "public"."node_type";
  personal boolean;
BEGIN
  SELECT n."type", coalesce(s."kind" = 'personal', false) INTO t, personal
    FROM "public"."nodes" n LEFT JOIN "public"."spaces" s ON s."id" = n."owner_id"
   WHERE n."id" = NEW."node_id";
  IF personal THEN
    RAISE EXCEPTION 'an item in a personal space cannot be granted to a workspace'
      USING ERRCODE = '23514';
  END IF;
  IF NOT "public"."mantle_grant_kind_ok"(t, NEW."workspace_id") THEN
    RAISE EXCEPTION 'a % can be granted to the Admin workspace only', t USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_item_grants_check_trg"() FROM PUBLIC;
--> statement-breakpoint

-- Rule 3: the move triggers fire on owner_id too.
DROP TRIGGER IF EXISTS "nodes_acl_moved_row" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_acl_moved_row" AFTER UPDATE OF "path", "owner_id" ON "public"."nodes"
  FOR EACH ROW WHEN (OLD."path"::text IS DISTINCT FROM NEW."path"::text
                     OR OLD."owner_id" IS DISTINCT FROM NEW."owner_id")
  EXECUTE FUNCTION "public"."mantle_nodes_moved_row_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_acl_path" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_acl_path" AFTER UPDATE OF "path", "owner_id" ON "public"."nodes"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_nodes_acl_path_trg"();
--> statement-breakpoint

-- Rule 2 kept on a move: an item that carries workspace grants cannot be
-- re-owned into a personal space (its grants would then sit on a personal
-- row). In W1 to W3 no item has grants, so this never fires there.
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_into_space_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."spaces" s WHERE s."id" = NEW."owner_id" AND s."kind" = 'personal')
     AND EXISTS (SELECT 1 FROM "public"."item_grants" g WHERE g."node_id" = NEW."id") THEN
    RAISE EXCEPTION 'an item with workspace grants cannot move into a personal space'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_into_space_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_into_space" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_into_space" AFTER UPDATE OF "owner_id" ON "public"."nodes"
  FOR EACH ROW WHEN (OLD."owner_id" IS DISTINCT FROM NEW."owner_id")
  EXECUTE FUNCTION "public"."mantle_nodes_into_space_trg"();
--> statement-breakpoint

-- Rule 4: a new folder's head counts as held when the transaction holds heads.
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_acl_after_ins_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  was text := coalesce(current_setting('mantle.acl_internal', true), '');
  held uuid[];
BEGIN
  INSERT INTO "public"."node_acl_head" ("node_id") VALUES (NEW."id")
    ON CONFLICT DO NOTHING;
  -- A folder this transaction made is its own: when the transaction holds
  -- heads, the new folder's head counts as held (update), so an item moved
  -- into a folder made in the same transaction (an Accept that creates its
  -- landing folder) passes the move check. Folders only: few per
  -- transaction, while the held list is re-signed on each append. Without
  -- held heads nothing is recorded: a later first mantle_lock_heads must
  -- still count as first.
  IF NEW."type" = 'branch' THEN
    held := "public"."mantle_heads_held"();
    IF cardinality(held) > 0 THEN
      PERFORM "public"."mantle_heads_set"(held || NEW."id",
                                           "public"."mantle_heads_held"(true) || NEW."id");
    END IF;
  END IF;
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
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_acl_after_ins_trg"() FROM PUBLIC;
--> statement-breakpoint

-- Rule 5: the named, logged bypass for migrations.
CREATE OR REPLACE FUNCTION "public"."mantle_heads_bypass"(name text)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF coalesce(btrim(name), '') = '' THEN
    RAISE EXCEPTION 'mantle_heads_bypass: name the migration' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('mantle.heads_bypass',
                     name || '|' || "public"."mantle_heads_mac"('bypass:' || name), true);
  INSERT INTO "public"."heads_check_misses" ("check_name", "node_id", "detail")
    VALUES ('bypass', NULL, left(name, 500));
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_heads_bypass"(text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_heads_check_mode"()
  RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  box text;
  sess text := coalesce(nullif(current_setting('mantle.heads_check', true), ''), 'warn');
  bypass text := coalesce(current_setting('mantle.heads_bypass', true), '');
  rank_box int;
  rank_sess int;
BEGIN
  -- Rule 5: a bypass that verifies (made by mantle_heads_bypass in this
  -- transaction) turns the check off; a hand-set one counts for nothing.
  -- (Nested: the signature is read only when a bypass is set, since it
  -- takes a transaction id.)
  IF bypass <> '' AND position('|' IN bypass) > 0 THEN
    IF split_part(bypass, '|', 2)
       = "public"."mantle_heads_mac"('bypass:' || split_part(bypass, '|', 1)) THEN
      RETURN 'off';
    END IF;
  END IF;
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
REVOKE EXECUTE ON FUNCTION "public"."mantle_heads_check_mode"() FROM PUBLIC;
