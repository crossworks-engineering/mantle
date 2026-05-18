-- Add 'reflector' to the agent_role enum. The reflector watches recent
-- conversations and appends to agents.persona_notes — style preferences,
-- relationship notes, corrections.
--
-- Isolated in its own migration with breakpoints=true because
-- `ALTER TYPE … ADD VALUE` can't share a transaction with DDL that uses
-- the new value (same reason 0008_node_type_telegram is isolated).

alter type "public"."agent_role" add value if not exists 'reflector';
