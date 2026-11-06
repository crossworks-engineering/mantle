-- Adds 'ui_action' to the trace_step_kind enum: one step per agent UI call
-- (docs/agent-ui.md), under the tool step of the turn that made it, so
-- Activity shows what the agent did in the person's window. In its own file
-- because `ALTER TYPE ... ADD VALUE` cannot run in the transaction that
-- later uses the value (same reason as 0331).

alter type "public"."trace_step_kind" add value if not exists 'ui_action';
