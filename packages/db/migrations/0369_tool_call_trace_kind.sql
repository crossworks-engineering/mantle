-- Add 'tool_call' to the trace_kind enum: one row per spending builtin (a
-- chat, vision, image or speech model call, `model_call` among them) called
-- where no trace is open, an app's tool broker or an MCP client
-- (packages/tools/src/dispatch.ts withSpendTrace). Its provider usage lands
-- on this row, so the cost screen counts it. subject_kind = 'tool',
-- data.tool = the slug, login_id = the login it ran for.
--
-- Isolated in its own migration: `ALTER TYPE ... ADD VALUE` cannot share a
-- transaction with DDL that uses the new value (docs/observability.md §10).
alter type "public"."trace_kind" add value if not exists 'tool_call';
