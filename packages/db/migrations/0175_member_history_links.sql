-- Member logins, Phase 6 stage 3: a team contact who redeemed an invite is
-- now a member login (auth.users.contact_id = the contact). Their old team
-- portal history is linked to the login, so the admin views and the tools can
-- find it by login:
--  - team_access_log gains login_id (SET NULL on login delete, like
--    contact_id: the record that something happened outlives the login);
--  - team_access_log and member node_comments rows of a contact with a member
--    login get that login.
-- Portal chat rows (team_messages) are NOT linked: a member's live thread is
-- read by login_id, and old portal turns must not enter it (or the model's
-- context). The admin views read them through the login's contact.
--
-- Cheap on a live database: the column is nullable with no default
-- (metadata only), the FK checks an all-NULL column, and the backfills touch
-- only rows of contacts that have a member login. A contact with two member
-- logins is ambiguous and is left alone. Idempotent: every backfill only
-- fills NULLs. Contacts redeemed later are linked by the invite redeem
-- (packages/content/src/member-invites.ts, linkContactHistoryToLogin).
ALTER TABLE "team_access_log" ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_access_log_login_fk') THEN
    ALTER TABLE "team_access_log" ADD CONSTRAINT "team_access_log_login_fk"
      FOREIGN KEY ("login_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
  END IF;
END
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_access_log_login_idx"
  ON "team_access_log" ("owner_id", "login_id", "created_at" DESC);
--> statement-breakpoint
-- A member login's own events (its chat turns and denials) named the login in
-- detail.login_id before the column existed.
UPDATE "team_access_log" l
   SET "login_id" = u."id"
  FROM "auth"."users" u
 WHERE l."login_id" IS NULL
   AND u."id" = CASE
         WHEN l."detail"->>'login_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN (l."detail"->>'login_id')::uuid
       END;
--> statement-breakpoint
UPDATE "team_access_log" l
   SET "login_id" = u."login_id"
  FROM (
    SELECT "contact_id", (array_agg("id"))[1] AS "login_id"
      FROM "auth"."users"
     WHERE "role" = 'member' AND "contact_id" IS NOT NULL
     GROUP BY "contact_id"
    HAVING count(*) = 1
  ) u
 WHERE l."login_id" IS NULL
   AND l."contact_id" = u."contact_id";
--> statement-breakpoint
-- A member's comment from the team portal carried the contact only.
UPDATE "node_comments" c
   SET "login_id" = u."login_id"
  FROM (
    SELECT "contact_id", (array_agg("id"))[1] AS "login_id"
      FROM "auth"."users"
     WHERE "role" = 'member' AND "contact_id" IS NOT NULL
     GROUP BY "contact_id"
    HAVING count(*) = 1
  ) u
 WHERE c."author_kind" = 'member'
   AND c."login_id" IS NULL
   AND c."contact_id" = u."contact_id";
