-- Add 'federation_request' to the trace_kind enum: one row per inbound
-- cross-Mantle read (a peer querying our federation API). subject_kind =
-- 'mantle_peer', subject_id = the peer row id, owner_id = the answering owner.
--
-- Isolated in its own migration with breakpoints=true because
-- `ALTER TYPE … ADD VALUE` can't share a transaction with DDL that uses the
-- new value (same reason 0017_reflector_role is isolated). See docs/federation.md
-- + observability.md §10 (adding a trace kind).
alter type "public"."trace_kind" add value if not exists 'federation_request';
