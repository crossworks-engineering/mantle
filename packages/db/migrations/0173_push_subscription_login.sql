-- A push device belongs to the LOGIN that enrolled it, not only to the brain.
-- Before this, push_subscriptions named only the anchor (owner_id), so
-- locking a login out (demote, disable, delete) left its phone on the relay
-- and still receiving the brain's pushes. Now POST records the signed-in
-- login, lockout deletes that login's devices and tells the relay, and
-- deleting a login deletes its devices (FK cascade).
--
-- Backfill: existing rows get the anchor (the is_owner login), the only login
-- a row can be attributed to, as 0164 did for connector grants. A device a
-- second admin paired before this release stays the anchor's; unpair it in
-- Settings if that admin is locked out. Nullable: a brain with no anchor row
-- keeps its devices unattributed rather than failing the migration.
ALTER TABLE "push_subscriptions" ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
UPDATE "push_subscriptions"
  SET "login_id" = (SELECT "id" FROM "auth"."users" WHERE "is_owner" LIMIT 1)
  WHERE "login_id" IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_login_fk') THEN
    ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_login_fk"
      FOREIGN KEY ("login_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_login_idx" ON "push_subscriptions" ("login_id");
