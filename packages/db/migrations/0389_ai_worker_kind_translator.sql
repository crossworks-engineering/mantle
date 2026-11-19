-- Add the `translator` worker kind. ADD VALUE only (Postgres allows adding an
-- enum value inside a transaction so long as it is not USED in the same one;
-- this migration only declares it; the first insert happens later, on the
-- boot reconcile's seed of required workers).
-- The Translator runs the `translate` tool: text or an item into a language.
-- It spends only when someone calls the tool; no trigger starts it.
ALTER TYPE "ai_worker_kind" ADD VALUE IF NOT EXISTS 'translator';
