-- A folder's grant change (mantle_apply_folder_change, 0241) takes the heads
-- of the whole subtree again before it derives the rows below. 0280 made the
-- public heads locks filter by the scope: for a write-role caller
-- mantle_lock_heads_more drops the items its scope does not read. With the
-- edit check on, an item below the folder that the caller cannot read was
-- never held, every round asked for it again, and after five rounds the
-- change failed with "subtree kept growing" (40001): a folder's home move,
-- or any grant change on a folder, by a Moderator who does not read every
-- item inside it.
--
-- The folder change is reached only from the propagate trigger, after the
-- caller's own change to the folder's row was allowed, and it rewrites the
-- derived rows of every item below the folder. So it locks every item below
-- it, read or not, with the unfiltered core (mantle_lock_heads_more_core),
-- as a folder rename takes the heads of the rows it carries along
-- (mantle_subtree_rewrite, 0282 and 0305). A busy head of an item the
-- caller cannot read raises 55P03 (NOWAIT), and the caller retries the whole
-- change, as for any busy head.
--
-- 0241's function with that one call changed. No table, no trigger, no row
-- changes, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0357_folder_change_heads.revert.sql.
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
      EXIT WHEN cardinality(ids) = 0;
      rounds := rounds + 1;
      IF rounds > 5 THEN
        RAISE EXCEPTION 'mantle_apply_folder_change: subtree kept growing' USING ERRCODE = '40001';
      END IF;
      -- Every item below, read by the caller or not: this rewrites them all.
      PERFORM "public"."mantle_lock_heads_more_core"(ids);
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
