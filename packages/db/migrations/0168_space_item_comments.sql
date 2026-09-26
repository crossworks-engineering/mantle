-- Member logins Phase 2: comments on personal items (plan v3.1 section 2d).
--
-- A member discusses a team-shared item with teammates, and a submitted item
-- with the reviewer. The comment rows keep owner_id = the brain (so the
-- thread survives Accept, when the item moves into the brain), author_kind
-- 'member' and login_id = the writing login.
--
-- Reads go through row security:
--  - the personal-space role reads the comments on its own space's items;
--  - the team role, with mantle.human on (a member's own request, never an
--    agent), reads the comments on teammates' team-shared items. Comments on
--    brain items stay admin: the rule requires a non-brain item.
-- Writes: the personal-space role writes its own login's comments on its own
-- items. A teammate's comment on someone else's shared item is written by the
-- app on the admin pool after a team-drafts read proved the item visible
-- (asSystem, one audited call site). The app decides WHEN commenting is open
-- (shared or submitted); these rules are the floor under it.
-- The brain test is mantle_is_brain_space() (0165, security definer): the
-- space role holds no grant on auth.users, so mantle_brain_id() is not open
-- to it.
ALTER TABLE "public"."node_comments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "node_comments_space_read" ON "public"."node_comments" FOR SELECT
  TO mantle_view_space
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "node_comments"."node_id"));
--> statement-breakpoint
CREATE POLICY "node_comments_space_insert" ON "public"."node_comments" FOR INSERT
  TO mantle_view_space
  WITH CHECK (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "node_comments"."node_id")
              AND "author_kind" = 'member'
              AND "login_id" = "public"."mantle_login_id"()
              AND "public"."mantle_is_brain_space"("owner_id"));
--> statement-breakpoint
CREATE POLICY "node_comments_space_update" ON "public"."node_comments" FOR UPDATE
  TO mantle_view_space
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "node_comments"."node_id")
         AND "login_id" = "public"."mantle_login_id"())
  WITH CHECK ("login_id" = "public"."mantle_login_id"() AND "author_kind" = 'member');
--> statement-breakpoint
CREATE POLICY "node_comments_space_delete" ON "public"."node_comments" FOR DELETE
  TO mantle_view_space
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "node_comments"."node_id")
         AND "login_id" = "public"."mantle_login_id"());
--> statement-breakpoint
CREATE POLICY "node_comments_team_drafts_read" ON "public"."node_comments" FOR SELECT
  TO mantle_view_team
  USING (current_setting('mantle.human', true) = 'on'
         AND EXISTS (SELECT 1 FROM "public"."nodes" n
                      WHERE n.id = "node_comments"."node_id"
                        AND NOT "public"."mantle_is_brain_space"(n.owner_id)));
--> statement-breakpoint
-- The my-space agent tools (plan 2e, "on behalf of"): a turn carries the
-- member's login, set by the server, never by the model; the tool maps it to
-- that login's personal space here and opens its own short space transaction.
-- SECURITY DEFINER: the limited roles hold no grant on spaces, and this
-- answers one id and reads nothing else.
CREATE OR REPLACE FUNCTION "public"."mantle_personal_space"(login uuid)
  RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
  SELECT s.id FROM "public"."spaces" s WHERE s.kind = 'personal' AND s.login_id = login
$$;
