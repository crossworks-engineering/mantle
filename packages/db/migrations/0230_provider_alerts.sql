-- Provider alerts (2026-10-04, docs/embeddings.md "Provider outages").
--
-- Two brains embedded through an account with no credits for days. Every
-- extract job failed five times and went to the dead-letter queue, chat turns
-- lost their retrieved context, and the only trace was a log line. This table
-- holds ONE row per brain and subject ('embedding', 'extraction'): the open
-- failure, if any, in words an admin can act on.
--
--   reason       fixed text chosen by code (provider-error.ts), NEVER the
--                provider's body: a body can carry an account id or a part of
--                the key.
--   visible      the writer sets it: a permanent account error (no credits,
--                refused key, unknown model, no key) at once; a transient one
--                (rate limit, 5xx, network) only after it has lasted 10 min.
--   paused       the extract queue stopped taking jobs for it (the circuit).
--   next_probe_at  when the agent tries ONE tiny call to see if it works
--                again (5 min, doubling to 1 h). An admin's "Try again" sets
--                it to now.
--   resolved_at  set when a call works again. The row stays as the record of
--                the last outage; the next failure starts it over.
--
-- A change in what an admin sees raises the existing `needs_you_changed`
-- event (0186) with the owner id, so the admin live stream and the admin push
-- worker pick it up with no new listener. Notify-only, like 0186: the function
-- writes nothing and no listener starts LLM work.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."provider_alerts" (
  "owner_id" uuid NOT NULL,
  "subject" text NOT NULL CHECK ("subject" IN ('embedding', 'extraction')),
  "code" text NOT NULL,
  "permanent" boolean NOT NULL,
  "reason" text NOT NULL,
  "provider" text,
  "model" text,
  "failing_since" timestamptz NOT NULL DEFAULT now(),
  "last_error_at" timestamptz NOT NULL DEFAULT now(),
  "error_count" integer NOT NULL DEFAULT 1,
  "visible" boolean NOT NULL DEFAULT false,
  "paused" boolean NOT NULL DEFAULT false,
  "next_probe_at" timestamptz,
  "probe_attempts" integer NOT NULL DEFAULT 0,
  "last_probe_at" timestamptz,
  "resolved_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_id", "subject")
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_notify_provider_alert"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('needs_you_changed', new.owner_id::text);
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_notify_provider_alert"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "provider_alerts_needs_you_ins_trg" ON "public"."provider_alerts";
--> statement-breakpoint
CREATE TRIGGER "provider_alerts_needs_you_ins_trg"
  AFTER INSERT ON "public"."provider_alerts"
  FOR EACH ROW
  WHEN (new.visible AND new.resolved_at IS NULL)
  EXECUTE FUNCTION "public"."mantle_notify_provider_alert"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "provider_alerts_needs_you_upd_trg" ON "public"."provider_alerts";
--> statement-breakpoint
-- Only what an admin sees: shown or hidden, the reason, paused or not. The
-- per-error counters and probe times change often and never fire.
CREATE TRIGGER "provider_alerts_needs_you_upd_trg"
  AFTER UPDATE ON "public"."provider_alerts"
  FOR EACH ROW
  WHEN ((old.visible AND old.resolved_at IS NULL)
          IS DISTINCT FROM (new.visible AND new.resolved_at IS NULL)
        OR (new.visible AND new.resolved_at IS NULL
            AND (old.code IS DISTINCT FROM new.code
                 OR old.paused IS DISTINCT FROM new.paused
                 OR old.failing_since IS DISTINCT FROM new.failing_since)))
  EXECUTE FUNCTION "public"."mantle_notify_provider_alert"();
