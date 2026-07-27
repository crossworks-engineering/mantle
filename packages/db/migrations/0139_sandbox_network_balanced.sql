-- Adds 'balanced' to the sandbox_network enum. Own file because
-- `ALTER TYPE … ADD VALUE` cannot run in the same transaction that later
-- references the new value (same isolation as 0136 and the other enum-adds).
--
-- 'balanced' is the sbx-style middle egress tier: the sandbox joins an
-- INTERNAL docker network (no NAT) and reaches the outside world only via
-- sandboxd's allowlisting CONNECT proxy — package registries, GitHub, apt
-- mirrors by default (SANDBOX_EGRESS_ALLOW extends). 'full' and 'none'
-- behave as before.

alter type "public"."sandbox_network" add value if not exists 'balanced';
