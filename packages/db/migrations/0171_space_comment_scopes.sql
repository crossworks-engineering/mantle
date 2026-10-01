-- Member logins, session 7 audit S6 and S5.
--
-- S6 (Jason, 2026-09-27: split by audience): a personal item's thread is two
-- conversations. Comments written while the item is shared with the team are
-- the team's ('team'); comments the author writes while it is private and
-- submitted are the review talk between author and reviewer ('review'). The
-- team role reads only the team's, even after the item is shared later.
-- Existing rows keep 'team' (what they were shown as until now).
ALTER TABLE "public"."node_comments"
  ADD COLUMN IF NOT EXISTS "thread_scope" text DEFAULT 'team' NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."node_comments" DROP CONSTRAINT IF EXISTS "node_comments_thread_scope_ck";
--> statement-breakpoint
ALTER TABLE "public"."node_comments" ADD CONSTRAINT "node_comments_thread_scope_ck"
  CHECK ("thread_scope" IN ('team', 'review'));
--> statement-breakpoint
DROP POLICY IF EXISTS "node_comments_team_drafts_read" ON "public"."node_comments";
--> statement-breakpoint
CREATE POLICY "node_comments_team_drafts_read" ON "public"."node_comments" FOR SELECT
  TO mantle_view_team
  USING (current_setting('mantle.human', true) = 'on'
         AND "thread_scope" = 'team'
         AND EXISTS (SELECT 1 FROM "public"."nodes" n
                      WHERE n.id = "node_comments"."node_id"
                        AND NOT "public"."mantle_is_brain_space"(n.owner_id)));
--> statement-breakpoint
-- S5: the space role's UPDATE rule checked less than its INSERT rule. No
-- route edits a member comment; the rule now holds the same line anyway.
DROP POLICY IF EXISTS "node_comments_space_update" ON "public"."node_comments";
--> statement-breakpoint
CREATE POLICY "node_comments_space_update" ON "public"."node_comments" FOR UPDATE
  TO mantle_view_space
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "node_comments"."node_id")
         AND "login_id" = "public"."mantle_login_id"())
  WITH CHECK (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "node_comments"."node_id")
              AND "author_kind" = 'member'
              AND "login_id" = "public"."mantle_login_id"()
              AND "public"."mantle_is_brain_space"("owner_id"));
