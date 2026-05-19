-- Extend tracing primitives so every pipeline decision is visible —
-- including the no-op skips that previously returned silently and
-- left operators wondering "what happened to my upload?"
--
-- Two enum additions:
--
--   * trace_status += 'skipped' — pipelines that consciously decline
--     to run (extractor: "already extracted"; summarizer: "threshold
--     not met"; reflector: "no new activity") now record a trace row
--     with this status + a disposition string in `data`. Operators
--     can filter /traces?status=skipped to see "what did the system
--     consider but decline?"
--
--   * trace_kind += 'content_ingest' — every data entry point (file
--     upload, note create, Telegram inbound, web upload, ...) opens
--     a content_ingest trace at the moment of arrival. The trace's
--     `subject_id` points at the resulting node so the new node-
--     biography page can answer "where did this come from?" without
--     parsing source-specific tables.
--
-- IF NOT EXISTS guards keep this re-runnable across environments
-- that may already have one or both values (defensive against an
-- aborted migration leaving the enum half-extended).

ALTER TYPE trace_status ADD VALUE IF NOT EXISTS 'skipped';
ALTER TYPE trace_kind ADD VALUE IF NOT EXISTS 'content_ingest';
