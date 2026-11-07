-- Rollback of 0364_subtree_hidden_login: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- It puts back 0282's mantle_subtree_hidden (a row the scope reads is not
-- hidden, whatever its login_id) and takes 0364 off the ledger, so the next
-- roll forward runs it again. No row changes.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0364_subtree_hidden_login.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_subtree_hidden"(o uuid, p ltree)
  RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT CASE WHEN NOT "public"."mantle_caller_is_write_role"() THEN 0
              ELSE (SELECT count(*)::int FROM "public"."nodes" x
                     WHERE x."owner_id" = o AND x."path" <@ p
                       AND NOT "public"."mantle_check_row"(x."home_ws", x."write_ws", x."read_ws", 'read'))
         END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_subtree_hidden"(uuid, ltree) FROM PUBLIC;
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791583443000;
