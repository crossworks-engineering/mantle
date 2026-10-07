-- A save never fails on an item deleted while it writes its embeds
-- (found 2026-10-01 by the share-drift fix, commit cda84224b; the same race
-- on the save path).
--
-- 0208's mantle_sync_embeds wrote a saved item's embed edges with
--   INSERT ... WHERE EXISTS (SELECT 1 FROM nodes x WHERE x.id = t)
-- The check reads its snapshot. An item deleted after that read, or by a
-- transaction still open when it ran, passed the check, and the foreign key
-- on node_embeds.to_id then failed the insert, and with it the user's save
-- of the page, drawing or note:
--
--   insert or update on table "node_embeds" violates foreign key constraint
--   "node_embeds_to_id_fkey"
--
-- Now the insert joins nodes for the target and locks it FOR KEY SHARE, as
-- the nightly repair does since cda84224b. Read committed then waits for a
-- delete in flight and skips the row when it turns out deleted: that edge
-- drops out and the save goes on. A delete that comes after waits for the
-- save, and its cascade removes the new edge. FOR KEY SHARE is the lock the
-- foreign key check takes anyway, so the insert waits for nothing it did
-- not wait for before.
--
-- Unchanged: the delete of the edges the data no longer names, the self
-- embed left out, ON CONFLICT DO NOTHING, the pinned search_path, and every
-- other function and trigger of 0208. The source (from_id) needs no lock:
-- for a note it is the row being written; for a page or a drawing a delete
-- of the item cascades through the pages or draws row the save holds.
--
-- Number and order: after 0215_tool_team_apps, stamped later.
--
-- Rollback: the previous function is 0208's, the same signature; the
-- previous release calls it the same way.

CREATE OR REPLACE FUNCTION "public"."mantle_sync_embeds"(f uuid, ids uuid[])
  RETURNS void LANGUAGE sql
  SET search_path = public, pg_temp AS $$
  DELETE FROM "public"."node_embeds"
   WHERE from_id = f AND NOT (to_id = ANY (coalesce(ids, '{}'::uuid[])));
  INSERT INTO "public"."node_embeds" (from_id, to_id)
  SELECT f, x.id FROM unnest(coalesce(ids, '{}'::uuid[])) t
    JOIN "public"."nodes" x ON x.id = t
   WHERE t <> f
     FOR KEY SHARE OF x
  ON CONFLICT DO NOTHING;
$$;
