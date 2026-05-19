-- Add 'photo_ingest' to the trace_kind enum so the agent can record
-- traces for Telegram photo → vision worker → note pipeline runs.
--
-- Why a new kind rather than reusing 'responder_turn':
-- photo_ingest is a SHORT-CIRCUIT path — no LLM responder turn happens.
-- Reusing responder_turn would muddle the /traces filters and make it
-- impossible to answer "how many photos did we ingest this week?"
-- without parsing the data jsonb. New kind = clean grouping.
--
-- Postgres requires ALTER TYPE for enum additions; the IF NOT EXISTS
-- guard makes this re-runnable across environments that may already
-- have it.

ALTER TYPE trace_kind ADD VALUE IF NOT EXISTS 'photo_ingest';
