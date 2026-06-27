-- Durable execution state for assistant turns (dedicated-API Phase 1). The web
-- /assistant turn currently runs the LLM loop INSIDE the HTTP request and dies
-- if the user navigates away. The apps/api runner will instead create the
-- outbound row 'pending' (a durable "thinking…" bubble), then flip it to
-- 'complete' (reply filled) or 'failed' (error set) — so in-progress + failed
-- states survive navigation and process restarts.
--
-- Defaulting status to 'complete' means every existing row + every inbound row
-- + every synchronous write classifies correctly with NO backfill (mirrors how
-- `channel` defaults to 'web'). Plain text, not a pg enum, so it stays
-- reversible. The DBOS workflow is the source of truth for execution; this is
-- the UI-facing projection. See docs/conversation.md.
ALTER TABLE "assistant_messages" ADD COLUMN "status" text NOT NULL DEFAULT 'complete';
--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN "error" text;
