-- Member logins, Phase 7: admin private items (Jason, 2026-09-28).
--
-- Every login has a personal space (0165), admins included. An admin now works
-- in theirs ("Keep private") and accepts into the brain themselves; nobody
-- else ever reads it: not another admin, not a member. The admin routes offer
-- no share, but a space_items row can still say 'team' for an admin's item:
-- a member who shared items and was then promoted keeps those rows. Until
-- now the team-drafts rules showed ANY team-shared personal item to the team
-- role, so a promoted admin's later edits would reach every member.
--
-- This is the floor under that: team drafts come from MEMBER spaces only.
-- A space counts as a member's while its login is a member, or is gone (a
-- deleted member's shared items stay readable as before, until an admin
-- accepts or discards them). The node comments rule follows the node (its
-- EXISTS on nodes runs under these rules), so teammates' threads are held
-- too. The app writes the same rule into its admin-pool queries
-- (member-review.ts, member-space-comments.ts).
--
-- SECURITY DEFINER: the limited roles hold no grant on spaces or logins, and
-- these answer one boolean and read nothing else.
--
-- Rollback: the previous code runs on these rules unchanged (it never shows
-- an admin's item on purpose). A hand re-run restores the 0165 policies.
CREATE OR REPLACE FUNCTION "public"."mantle_member_space"(space uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."spaces" s
     WHERE s.id = space AND s.kind = 'personal'
       AND NOT EXISTS (SELECT 1 FROM "auth"."users" u
                        WHERE u.id = s.login_id AND u.role <> 'member'))
$$;
--> statement-breakpoint
-- The same, by node: for the space_items rule, which cannot read nodes
-- itself (the nodes rule reads space_items: the two would recurse).
CREATE OR REPLACE FUNCTION "public"."mantle_member_space_node"(node uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM "public"."nodes" n
                  WHERE n.id = node AND "public"."mantle_member_space"(n.owner_id))
$$;
--> statement-breakpoint
DROP POLICY IF EXISTS "space_items_team_read" ON "public"."space_items";
--> statement-breakpoint
CREATE POLICY "space_items_team_read" ON "public"."space_items" FOR SELECT
  TO mantle_view_team
  USING ("sharing" = 'team' AND current_setting('mantle.human', true) = 'on'
         AND "public"."mantle_member_space_node"("node_id"));
--> statement-breakpoint
DROP POLICY IF EXISTS "nodes_team_drafts_read" ON "public"."nodes";
--> statement-breakpoint
CREATE POLICY "nodes_team_drafts_read" ON "public"."nodes" FOR SELECT
  TO mantle_view_team
  USING (current_setting('mantle.human', true) = 'on'
         AND "owner_id" IS DISTINCT FROM "public"."mantle_brain_id"()
         AND "public"."mantle_workspace_kind"("type")
         AND "public"."mantle_member_space"("owner_id")
         AND EXISTS (SELECT 1 FROM "public"."space_items" si
                      WHERE si.node_id = "nodes"."id" AND si.sharing = 'team'));
