-- Team Forum turn serialization hardening (P0 audit fix).
--
-- `workflow_id` links an AGENT pending post to the DBOS forum-turn workflow
-- that created it. It makes the pending insert idempotent under DBOS recovery
-- replay: a workflow that crashed between committing its pending row and
-- journaling the step re-runs the step, finds ITS OWN pending row by
-- workflow_id, and adopts it instead of conflicting with the one-pending-agent-
-- post-per-topic unique index. Null on member/owner posts and on pre-existing
-- rows. Forward-only additive; safe to re-run.

alter table "forum_posts"
  add column if not exists "workflow_id" text;--> statement-breakpoint

-- Adopt-own-pending lookup: (topic, workflow_id) among pending agent rows.
create index if not exists "forum_posts_workflow_idx"
  on "forum_posts" ("topic_id", "workflow_id")
  where "author_kind" = 'agent' and "status" = 'pending';
