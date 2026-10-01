-- Client logins C6: the informational flag on an app (docs/client-logins.md
-- section 10). An app an admin sets to team or client level is a shared
-- workspace: everyone who can run it writes its database. An admin can mark
-- it informational (`data_read_only`): then members and clients only read its
-- data. Only the owner's app update route (PATCH /api/apps/:id) sets it.
--
-- The viewer roles read it (the access matrix grants it with the other app
-- columns at every migrate): the member and client app lookups run on those
-- roles.
--
-- Rollback: the previous release never reads the column; with it, members
-- write team apps only and no client runs an app.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

ALTER TABLE "public"."apps"
  ADD COLUMN IF NOT EXISTS "data_read_only" boolean NOT NULL DEFAULT false;
