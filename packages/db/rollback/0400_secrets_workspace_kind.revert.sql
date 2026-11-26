-- Rollback of 0400_secrets_workspace_kind: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- An older image keeps secrets in the Admin workspace and writes them on
-- the keys area's exit, on the system pool by the brain's id: every Admin
-- user with the keys area then sees every secret, those homed in a member's
-- workspace after 0400 too (trusted users; members see none). This revert
-- puts 'secret' back with the Admin-only kinds (a grant to another
-- workspace stays on its row but reads nothing: the kind's rule refuses it),
-- drops the sealed reader, and takes 0400 off the ledger, so the next roll
-- forward runs it again (0400 is re-runnable). mantle_secret_put keeps its
-- replace: the older image calls it only for a new secret, where it inserts
-- as before.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0400_secrets_workspace_kind.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
CREATE OR REPLACE FUNCTION "public"."mantle_kind_class"(t "public"."node_type")
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN t IN ('branch', 'file', 'note', 'page', 'table', 'app', 'formula', 'draw',
               'task', 'event', 'recall', 'present') THEN 'workspace'
    WHEN t = 'telegram_message' THEN 'conversation'
    ELSE 'admin_only'
  END
$$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_secret_sealed"(uuid);
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792340360000;
