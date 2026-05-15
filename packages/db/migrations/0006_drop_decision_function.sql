-- Sender decision logic is canonical in TypeScript (`SenderResolver` in
-- @mantle/email) — the SQL function `sender_effective_status` introduced
-- in 0001 was never called from app code and represented a parallel
-- implementation that could drift. Dropping it leaves a single source of
-- truth.
--
-- If a future use case wants the resolution available to ad-hoc SQL
-- (Studio reports, BI exports), revive the function with the same name
-- and add a parity test against the TS implementation.

drop function if exists "public"."sender_effective_status"(uuid, text, "public"."ingest_policy");
