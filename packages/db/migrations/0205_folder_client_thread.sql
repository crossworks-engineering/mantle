-- The item tree, phase 4: the client thread on a FOLDER-shared item
-- (docs/folder-tree.md, "Sharing a folder"; client logins C5, decision 8).
--
-- 0194 gave a brain item at client level its client thread (comments with
-- thread_scope 'client'), read by the client role and the team role with the
-- human flag on. "At client level" was the item's own level only. Since 0204
-- an item is also read at the share it inherits from a folder, so an item in
-- a folder shared with clients is read by clients without a thread to talk
-- on. The one change: the read rule takes the union rule nodes_viewer_read
-- uses (own level OR inherited share), for the 'client' level. Still a
-- same-row check on the item; nothing else about the rule changes.
--
-- The writes are the app's (packages/content/src/client-thread.ts,
-- node-comments.ts), on the admin pool with the same union check in the
-- statement. When the folder is unshared or the item moves out, the thread
-- is unread again below admin, exactly as when an item's own level changes.
--
-- Number and order: it runs after 0204_folder_sharing (the column it reads);
-- both were renumbered on landing after main's Recall v2 migrations (0201
-- to 0203), each stamped later than main's latest so no box skips them.
--
-- Rollback: the previous release reads the thread by the own level only; its
-- rule is the narrower one, and the rows this release wrote stay admin-read
-- until the item is at client level by its own.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

DROP POLICY IF EXISTS "node_comments_client_thread_read" ON "public"."node_comments";
--> statement-breakpoint
CREATE POLICY "node_comments_client_thread_read" ON "public"."node_comments" FOR SELECT
  TO mantle_view_team, mantle_view_client
  USING (coalesce(current_setting('mantle.human', true), '') = 'on'
         AND "thread_scope" = 'client'
         AND EXISTS (SELECT 1 FROM "public"."nodes" n
                      WHERE n.id = "node_comments"."node_id"
                        AND (n.audience = 'client' OR n.inherited_level = 'client')
                        AND n.owner_id = (SELECT "public"."mantle_brain_id"())));
