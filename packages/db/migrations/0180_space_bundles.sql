-- Member logins, final audit fixes (data): the submitted bundle, orphaned
-- spaces, deleted logins in team drafts, and EXECUTE on the space functions.
--
-- F04: only the submitted item itself was frozen. What renders inside it (an
-- embedded drawing or file, a child page) stayed editable and deletable, and
-- Accept worked out the bundle again at accept time, so the admin accepted
-- versions they never reviewed and the author's drafts on those items were
-- dropped. Submit now records the bundle here, one row per item (the root
-- included, in bundle order). While the root is submitted, every item in its
-- recorded bundle is frozen too (mantle_space_item_frozen below, and the
-- app's assertEditable). Recall, Return and Accept clear the rows; Accept
-- moves exactly the recorded bundle. A root submitted before this migration
-- has no rows: it keeps the old behaviour (bundle worked out at accept).
--
-- F21: a hard-deleted login's space (login_id goes null) was never purged,
-- and mantle_member_space() counted it as a member's, so a deleted admin who
-- had once been a member re-exposed old team rows. A space now records when
-- it lost its login (orphaned_at), the purge treats that like a deactivation,
-- and a space with no login is NOT a member's for team drafts.
--
-- F22: the SECURITY DEFINER space functions kept EXECUTE for PUBLIC. Revoked,
-- and granted to the roles whose rules and triggers call them (as 0169 did
-- for mantle_personal_space).
--
-- Rollback: the previous code runs on this schema (it never reads the new
-- table or column). Its Submit writes no bundle rows, so its submissions
-- freeze the root only, as before.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."space_item_bundles" (
  -- The submitted item. Its state row goes, its bundle rows go.
  "root_id"  uuid NOT NULL REFERENCES "public"."space_items"("node_id") ON DELETE CASCADE,
  -- An item that renders inside it (the root itself included).
  "node_id"  uuid NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  -- Bundle order: the root first, a parent page before its children.
  "position" integer NOT NULL,
  PRIMARY KEY ("root_id", "node_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_item_bundles_node_idx"
  ON "public"."space_item_bundles" ("node_id");
--> statement-breakpoint
ALTER TABLE "public"."space_item_bundles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The space role reads and writes the bundles of its own items only (the
-- nodes rules apply inside the EXISTS). A bundle is written before the root
-- is submitted and removed after it stops being submitted: while it is
-- submitted, nothing below admin changes it, so the author cannot unfreeze
-- an item by dropping it from the bundle. No UPDATE rule: rows never change.
DROP POLICY IF EXISTS "space_item_bundles_space_read" ON "public"."space_item_bundles";
--> statement-breakpoint
CREATE POLICY "space_item_bundles_space_read" ON "public"."space_item_bundles" FOR SELECT
  TO mantle_view_space
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "space_item_bundles"."root_id"));
--> statement-breakpoint
DROP POLICY IF EXISTS "space_item_bundles_space_insert" ON "public"."space_item_bundles";
--> statement-breakpoint
CREATE POLICY "space_item_bundles_space_insert" ON "public"."space_item_bundles" FOR INSERT
  TO mantle_view_space
  WITH CHECK (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "space_item_bundles"."root_id")
              AND EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "space_item_bundles"."node_id")
              AND NOT EXISTS (SELECT 1 FROM "public"."space_items" si
                               WHERE si.node_id = "space_item_bundles"."root_id"
                                 AND si.review_state = 'submitted'));
--> statement-breakpoint
DROP POLICY IF EXISTS "space_item_bundles_space_delete" ON "public"."space_item_bundles";
--> statement-breakpoint
CREATE POLICY "space_item_bundles_space_delete" ON "public"."space_item_bundles" FOR DELETE
  TO mantle_view_space
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "space_item_bundles"."root_id")
         AND NOT EXISTS (SELECT 1 FROM "public"."space_items" si
                          WHERE si.node_id = "space_item_bundles"."root_id"
                            AND si.review_state = 'submitted'));
--> statement-breakpoint

-- The frozen rule follows the bundle: an item is frozen while it is submitted
-- or accepted, and while it is in the recorded bundle of a submitted item.
-- Read under the writer's own rules, so a member only ever sees their own
-- space's bundles here (a bundle never reaches outside its space).
CREATE OR REPLACE FUNCTION "public"."mantle_space_item_frozen"(node uuid)
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM "public"."space_items" si
                  WHERE si.node_id = node AND si.review_state IN ('submitted', 'accepted'))
      OR EXISTS (SELECT 1 FROM "public"."space_item_bundles" b
                   JOIN "public"."space_items" si ON si.node_id = b.root_id
                  WHERE b.node_id = node AND si.review_state = 'submitted')
$$;
--> statement-breakpoint

-- ── F21: orphaned spaces ────────────────────────────────────────────────────
ALTER TABLE "public"."spaces" ADD COLUMN IF NOT EXISTS "orphaned_at" timestamptz;
--> statement-breakpoint
-- Set when the login goes (the ON DELETE SET NULL of 0165 is an UPDATE of
-- login_id, so this sees every hard delete, whatever path makes it). Pure
-- bookkeeping: it starts nothing.
CREATE OR REPLACE FUNCTION "public"."mantle_space_orphaned"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.login_id IS NULL AND OLD.login_id IS NOT NULL THEN
    NEW.orphaned_at := now();
  ELSIF NEW.login_id IS NOT NULL THEN
    NEW.orphaned_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "spaces_orphaned_trg" ON "public"."spaces";
--> statement-breakpoint
CREATE TRIGGER "spaces_orphaned_trg"
  BEFORE UPDATE OF "login_id" ON "public"."spaces"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_space_orphaned"();
--> statement-breakpoint
-- Spaces already without a login: their 30 days start now.
UPDATE "public"."spaces" SET "orphaned_at" = now()
 WHERE "kind" = 'personal' AND "login_id" IS NULL AND "orphaned_at" IS NULL;
--> statement-breakpoint

-- A space is a member's while its login is a member. A space with no login
-- is not: a deleted member's shared items leave Team drafts (an admin still
-- finds them in the Review queue as left behind), and a deleted admin's old
-- rows never come back.
CREATE OR REPLACE FUNCTION "public"."mantle_member_space"(space uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."spaces" s
      JOIN "auth"."users" u ON u.id = s.login_id
     WHERE s.id = space AND s.kind = 'personal' AND u.role = 'member')
$$;
--> statement-breakpoint
-- The admins' spaces now: what they shared or submitted while they were
-- members goes back to private drafts (a promotion does the same from now
-- on, users/[id] PATCH). Nobody could read or review those items anyway;
-- this stops a later demotion or delete from bringing them back, and lets
-- the admin edit a submitted item nobody can recall.
DELETE FROM "public"."space_item_bundles" b
 USING "public"."nodes" n, "public"."spaces" s, "auth"."users" u
 WHERE n.id = b.root_id AND s.id = n.owner_id AND s.kind = 'personal'
   AND u.id = s.login_id AND u.role <> 'member';
--> statement-breakpoint
UPDATE "public"."space_items" si
   SET "sharing" = 'private',
       "review_state" = CASE WHEN si.review_state = 'submitted' THEN 'draft' ELSE si.review_state END,
       "submitted_at" = CASE WHEN si.review_state = 'submitted' THEN NULL ELSE si.submitted_at END,
       "updated_at" = now()
  FROM "public"."nodes" n, "public"."spaces" s, "auth"."users" u
 WHERE n.id = si.node_id AND s.id = n.owner_id AND s.kind = 'personal'
   AND u.id = s.login_id AND u.role <> 'member'
   AND (si.sharing = 'team' OR si.review_state = 'submitted');
--> statement-breakpoint

-- ── F22: EXECUTE on the SECURITY DEFINER space functions ────────────────────
-- mantle_is_brain_space: the nodes triggers run as the writer (the space
-- role for a member), and the node_comments rules of the space and team
-- roles call it. The member-space pair: the team-drafts rules of the team
-- role. The admin pool owns them.
REVOKE EXECUTE ON FUNCTION "public"."mantle_is_brain_space"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_is_brain_space"(uuid)
  TO mantle_view_team, mantle_view_space;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_member_space"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_member_space"(uuid) TO mantle_view_team;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_member_space_node"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_member_space_node"(uuid) TO mantle_view_team;
