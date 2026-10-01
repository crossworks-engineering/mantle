-- Login sessions can be ended (final audit F06), and one contact names one
-- login (final audit F31).
--
-- 1. session_epoch. The session cookie is stateless ({uid, exp}, one year),
-- so until now nothing could end a copied cookie: not a password change, not
-- a disable and re-enable. The cookie (and the short `?at=` asset token) now
-- carries the login's epoch, signed, and every request compares it with this
-- column. Bumping the column ends every cookie and asset token the login
-- holds at once. A cookie minted before this release carries no epoch and
-- counts as 0, so every existing session keeps working until the login's
-- first bump. Bearers (mobile_tokens) are rows, so they are revoked by row.
--
-- 2. One login per contact. The users route refused a second login on a
-- contact, and the invite redeem too, but only by reading first: two requests
-- at once could both pass. A partial unique index makes it a rule. If a box
-- already holds two logins on one contact the migration stops with the ids,
-- instead of failing on the index with a bare duplicate-key error: unlink the
-- extra login (PATCH /api/users/:id with contactId null) and upgrade again.
--
-- Rollback: the previous release ignores both (it never reads the column, and
-- its own pre-check already keeps contacts unique).
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "session_epoch" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$
DECLARE
  dupes text;
BEGIN
  SELECT string_agg(contact_id::text || ' (' || n || ' logins)', ', ')
    INTO dupes
    FROM (SELECT contact_id, count(*) AS n
            FROM "auth"."users"
           WHERE contact_id IS NOT NULL
           GROUP BY contact_id
          HAVING count(*) > 1) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'login session epoch aborted: more than one login is linked to the same contact: %. Unlink the extra logins (PATCH /api/users/:id with contactId null), then upgrade again. See docs/member-logins.md.', dupes;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_contact_id_unique"
  ON "auth"."users" ("contact_id") WHERE "contact_id" IS NOT NULL;
