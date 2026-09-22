-- Add the `decider` worker kind. ADD VALUE only (Postgres allows adding an
-- enum value inside a transaction so long as it isn't USED in the same one;
-- this migration only declares it; the first insert happens later, on seed).
-- Optional worker: a typed-decision model (TypeSafe Jev through OpenRouter's
-- decisions endpoint) that returns choice / score / yes-no answers with
-- probabilities instead of prose. Every call site keeps its current path when
-- no decider worker exists or the call fails, so this is non-breaking. The
-- manifest ships the worker DISABLED; the owner switches it on per use.
ALTER TYPE "ai_worker_kind" ADD VALUE IF NOT EXISTS 'decider';
