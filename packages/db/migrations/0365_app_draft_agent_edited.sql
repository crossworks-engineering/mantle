-- An app draft an in-app agent edited (docs/agent-ui.md): apps
-- .draft_agent_edited is set by a draft save the window's agent made
-- (PUT /api/apps/:id/draft carrying x-mantle-agent-call) and cleared by a
-- save the person made, a publish and a discard. While it is set, the app
-- tool broker refuses the calls of the draft's build (the Admin user's
-- preview), tagged or not: code an agent wrote never calls a tool until a
-- person saved it. The published build is not touched.
--
-- Every existing app keeps false: nothing changes for it. Grants come from
-- the access matrix (the app's code columns, a Moderator's, and the draft
-- columns the workspace role reads), never from here.
--
-- Additive: one column with a constant default (no table rewrite), no
-- trigger, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0365_app_draft_agent_edited.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."apps"
  ADD COLUMN IF NOT EXISTS "draft_agent_edited" boolean DEFAULT false NOT NULL;
