-- A folder's grant change (mantle_apply_folder_change, 0241) takes the heads
-- of the whole subtree again before it derives the rows below. 0280 made the
-- heads locks filter by the scope: a write-role caller locks only the items
-- its scope reads (mantle_heads_scope_filter, in mantle_lock_heads,
-- mantle_lock_heads_more and mantle_lock_subtree_heads). This function was
-- left out. With the edit check on, an item below the folder that the
-- caller cannot read was never held, every round asked for it again, and
-- after five rounds the change failed with "subtree kept growing" (40001):
-- a folder's home move, or any grant change on a folder, by a Moderator who
-- does not read every item inside it. Now each round's missing ids pass the
-- same filter first, as mantle_lock_subtree_heads does: the subtree locks
-- and the folder change take the same heads.
--
-- 0241's function with that one line added. No table, no trigger, no row
-- changes, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0355_folder_change_scope_filter.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_apply_folder_change"(folder uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  r record;
  ids uuid[];
  held uuid[];
  rounds int := 0;
BEGIN
  SELECT "owner_id", "path", "type" INTO r FROM "public"."nodes" WHERE "id" = folder;
  IF NOT FOUND OR r."type" <> 'branch' THEN RETURN; END IF;
  held := "public"."mantle_heads_held"();
  IF cardinality(held) > 0 THEN
    LOOP
      -- As in mantle_lock_subtree_heads: one read per round, a set difference.
      SELECT coalesce(array_agg(d.id ORDER BY d.id), '{}'::uuid[]) INTO ids
        FROM (SELECT n."id" FROM "public"."nodes" n
               WHERE n."owner_id" = r."owner_id" AND n."path" <@ r."path"
              EXCEPT
              SELECT h.x FROM unnest(held) AS h(x)) d;
      -- As there too: a write-role caller locks only what its scope reads.
      ids := "public"."mantle_heads_scope_filter"(ids);
      EXIT WHEN cardinality(ids) = 0;
      rounds := rounds + 1;
      IF rounds > 5 THEN
        RAISE EXCEPTION 'mantle_apply_folder_change: subtree kept growing' USING ERRCODE = '40001';
      END IF;
      PERFORM "public"."mantle_lock_heads_more"(ids);
      held := "public"."mantle_heads_held"();
    END LOOP;
  ELSE
    PERFORM "public"."mantle_heads_miss"('folder_change', folder, 'folder grant changed without heads');
  END IF;
  PERFORM "public"."mantle_rederive_subtree"(folder, false);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_apply_folder_change"(uuid) FROM PUBLIC;
