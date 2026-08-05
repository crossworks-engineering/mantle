-- Add the `suggester` worker kind. ADD VALUE only (Postgres allows adding an
-- enum value inside a transaction so long as it isn't USED in the same one;
-- this migration only declares it; the first insert happens later, on seed).
-- Optional worker: proposes ONE follow-up question after a completed assistant
-- turn. When a brain has no suggester worker the runtime falls back to the
-- narrator, then the summarizer, so this is non-breaking.
ALTER TYPE "ai_worker_kind" ADD VALUE IF NOT EXISTS 'suggester';
