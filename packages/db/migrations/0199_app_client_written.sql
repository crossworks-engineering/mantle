-- Client tier audit 2026-09-30, I3: remember that a client wrote an app's
-- database. A Table exported from an app at client level is client-sourced
-- for the lowering guard (packages/tools/src/client-sourced.ts). The mark
-- used to follow the app's level NOW, so raising the app above client
-- dropped it at once, while the rows clients wrote stayed in its database
-- and in every later export. `client_written_at` is set on a client's first
-- write (the client db-broker) and never cleared: the export keeps the mark
-- until it is removed, and the app's data goes with the app (the registry
-- row cascades on delete).
--
-- Rollback: the previous release never reads the column; with it, the mark
-- again follows the app's level only.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

ALTER TABLE "public"."app_databases"
  ADD COLUMN IF NOT EXISTS "client_written_at" timestamptz;
