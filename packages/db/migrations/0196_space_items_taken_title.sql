-- Client logins C5 audit (L6): the title an item had when a reviewer took it
-- over.
--
-- A taken item sits in the admin's private space, and the admin may rename
-- it while working on it ("Reject, over credit limit"). Its author still
-- lists it (a `with-admin` row in Mine and My requests, a title and a kind,
-- nothing else), and that row must show the title the author gave it, never
-- the admin's working title. Take over records the title here; Give back and
-- Accept clear it (the item is the author's again, or the brain's, with its
-- accepted snapshot). A taken item taken again (its admin is gone) keeps the
-- title recorded the first time.
--
-- Items already taken get the title they have now: the best there is (an
-- admin rename made before the roll is in it), and later renames no longer
-- reach the author.
--
-- Rollback: the previous code runs on this schema. It never reads the new
-- column, so a rollback shows authors the live title again.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."space_items" ADD COLUMN IF NOT EXISTS "taken_title" text;
--> statement-breakpoint
UPDATE "public"."space_items" si SET "taken_title" = n."title"
  FROM "public"."nodes" n
 WHERE n."id" = si."node_id" AND si."review_state" = 'taken' AND si."taken_title" IS NULL;
