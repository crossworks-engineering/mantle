-- The decider's provider alert (decider plan Part 3, docs/decisions.md
-- "Failures an admin sees"): subject `decision` on provider_alerts.
--
-- Until now a decider failure was silent: decide() returns null, the
-- breaker opens, and the brain loses the decider's gain with no word to
-- anyone. The decider now records its failures here through the same
-- throttled reporter as embedding and extraction (@mantle/db
-- provider-outage.ts): one write per brain and minute per process, and a
-- decision that works closes the row. The store's rules are unchanged: a
-- permanent reason (a refused key, no credits, a 404 under the privacy
-- setting) shows at once, a transient one (timeouts, unusable answers)
-- after 10 min.
--
-- The row stays after it closes, as the record of the last failure: the
-- decider worker screen reads it (when, which model, the plain reason).
-- The extract circuit never reads, probes or pauses on it. The existing
-- notify triggers (0230) fire for it as for the other subjects;
-- notify-only, nothing listening starts LLM work. A box whose decider never
-- fails never writes one.
-- Revert: packages/db/rollback/0353_provider_alerts_decision.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."provider_alerts" DROP CONSTRAINT IF EXISTS "provider_alerts_subject_check";
--> statement-breakpoint
ALTER TABLE "public"."provider_alerts"
  ADD CONSTRAINT "provider_alerts_subject_check"
  CHECK ("subject" IN ('embedding', 'extraction', 'model_policy', 'decision'));
