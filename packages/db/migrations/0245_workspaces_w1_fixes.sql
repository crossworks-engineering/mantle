-- Workspaces W1 audit fixes (plan page 4887b8e7, U1, V5).
--
-- 1. A move is exempt from the heads check only when the row was in a
--    personal space BEFORE and AFTER it. 0244 rule 1 read the owner after the
--    update, so a brain item moved into a personal space needed no heads: the
--    row and its new folder both looked personal, the old brain folder was
--    never checked, and the move could race a folder grant change. The row
--    trigger now notes the old owner next to the moved id, and the statement
--    trigger checks every moved row that was or is a brain row.
-- 2. spaces.kind is frozen. Flipping a space to 'personal' would exempt every
--    row it owns from the heads check and from grants (0244 rules 1 and 2).
--
-- No trigger here starts LLM work: checks and the existing re-derivation.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "public"."mantle_moved_nodes" ADD COLUMN IF NOT EXISTS "old_owner" uuid;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_nodes_moved_row_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  -- A row moved twice in one statement keeps where it came from.
  INSERT INTO "public"."mantle_moved_nodes" ("xid", "id", "old_owner")
    VALUES (pg_current_xact_id(), NEW."id", OLD."owner_id") ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_moved_row_trg"() FROM PUBLIC;
--> statement-breakpoint

-- 0241's statement trigger, with the heads check of the moved rows taken
-- from the old AND the new owner (fix 1). Everything else is as in 0241.
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_acl_path_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  me xid8;
  moved uuid[];
  strict_ids uuid[];
  roots uuid[];
  folders uuid[];
  held uuid[];
  missing uuid;
  m record;
  root uuid;
BEGIN
  me := pg_current_xact_id_if_assigned();
  IF me IS NULL THEN RETURN NULL; END IF;
  WITH taken AS (
    DELETE FROM "public"."mantle_moved_nodes" t WHERE t."xid" = me
      RETURNING t."id", t."old_owner"
  ), classed AS (
    SELECT tk."id",
           coalesce((SELECT s."kind" = 'personal' FROM "public"."spaces" s
                      WHERE s."id" = tk."old_owner"), false) AS was_personal,
           coalesce((SELECT s."kind" = 'personal' FROM "public"."nodes" n
                       JOIN "public"."spaces" s ON s."id" = n."owner_id"
                      WHERE n."id" = tk."id"), false) AS is_personal
      FROM taken tk
  )
  SELECT coalesce(array_agg("id"), '{}'::uuid[]),
         coalesce(array_agg("id") FILTER (WHERE NOT (was_personal AND is_personal)), '{}'::uuid[])
    INTO moved, strict_ids
    FROM classed;
  IF cardinality(moved) = 0 THEN RETURN NULL; END IF;

  SELECT coalesce(array_agg(n."id"), '{}'::uuid[]),
         coalesce(array_agg(DISTINCT pf."id") FILTER (WHERE pf."id" IS NOT NULL), '{}'::uuid[])
    INTO roots, folders
    FROM "public"."nodes" n
    LEFT JOIN "public"."nodes" pf
      ON pf."owner_id" = n."owner_id" AND pf."type" = 'branch'
     AND pf."path" = "public"."mantle_parent_folder_path"(n."type", n."path")
   WHERE n."id" = ANY (moved)
     AND (pf."id" IS NULL OR NOT (pf."id" = ANY (moved)));

  -- Fix 1: a row that was or is a brain row needs its head held for update,
  -- wherever it lands. No personal-space exemption for it (0244 rule 1 reads
  -- the owner after the update, which is the hole this closes).
  IF cardinality(strict_ids) > 0 AND "public"."mantle_heads_check_mode"() <> 'off' THEN
    held := "public"."mantle_heads_held"(true);
    SELECT d.x INTO missing
      FROM (SELECT u.x FROM unnest(strict_ids) AS u(x)
            EXCEPT
            SELECT h.x FROM unnest(held) AS h(x)) d
     LIMIT 1;
    IF missing IS NOT NULL THEN
      PERFORM "public"."mantle_heads_miss"('nodes_move', missing, 'head not locked first for update');
    END IF;
  END IF;
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
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_acl_path_trg"() FROM PUBLIC;
--> statement-breakpoint

-- Fix 2: a space's kind never changes.
CREATE OR REPLACE FUNCTION "public"."mantle_spaces_kind_frozen_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF OLD."kind" IS DISTINCT FROM NEW."kind" THEN
    RAISE EXCEPTION 'a space''s kind cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_spaces_kind_frozen_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "spaces_kind_frozen" ON "public"."spaces";
--> statement-breakpoint
CREATE TRIGGER "spaces_kind_frozen" BEFORE UPDATE OF "kind" ON "public"."spaces"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_spaces_kind_frozen_trg"();
