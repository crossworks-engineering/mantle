-- Runs slice 2: the `worker` agent role (docs/runs.md; plan §6).
--
-- Workers are TEMPLATES, not resident processes: configuration (model, kit,
-- instructions) that each `worker_invoke` run item instantiates as a fresh
-- agent turn. Propose-don't-mutate: their kit is read/search only, and the
-- runtime executes them at delegation depth 2 so `run_*` / `invoke_agent`
-- refuse (no recursion). Distinct from chat roles — CHATTABLE_ROLES excludes
-- 'worker', so a worker can never be picked as a conversation responder.
--
-- Model inheritance: a worker whose model is the sentinel 'inherit' runs on
-- the responder's model/provider/key at execution time (the default — the
-- out-of-box win is traceable runs + audit, not cost arbitrage). No schema
-- change needed for that; the sentinel avoids making agents.model nullable
-- (a string|null ripple through every chat path for one consumer).
--
-- Enum-only migration; nothing here uses the value (migrate.ts replay rule).

ALTER TYPE "agent_role" ADD VALUE IF NOT EXISTS 'worker';
