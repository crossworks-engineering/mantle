-- Rollback of 0357_folder_change_heads: what an operator MAY run
-- before pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- It puts back 0241's mantle_apply_folder_change (its rounds through the
-- filtered mantle_lock_heads_more) and
-- takes 0357 off the ledger, so the next roll forward runs it again. No row
-- changes.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0357_folder_change_heads.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
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
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791237660000;
