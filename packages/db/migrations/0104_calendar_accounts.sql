-- Provider-agnostic calendar ingestion. calendar_accounts = a subscribed
-- external calendar source; the first provider is `ics` (an iCalendar feed URL,
-- covering Google's secret iCal address, Outlook published calendars, Apple,
-- CalDAV…). The feed URL is sealed (AAD = row id). Synced events are ordinary
-- `event` nodes carrying provenance in `data` (external_uid / external_account_id
-- / external_source); the partial index makes the dedup lookup fast. See
-- docs/calendar-ingest.md.
CREATE TABLE "calendar_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"feed_url_enc" bytea,
	"color" text,
	"enabled" boolean NOT NULL DEFAULT true,
	"sync_state" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"last_event_count" integer,
	"last_sync_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "calendar_accounts_owner_idx" ON "calendar_accounts" ("owner_id");
--> statement-breakpoint
-- Fast dedup lookup for synced events by their external uid (scoped to event
-- nodes that actually carry one).
CREATE INDEX "nodes_event_external_uid_idx" ON "nodes" ("owner_id", (("data"->>'external_uid')))
	WHERE "type" = 'event' AND ("data"->>'external_uid') IS NOT NULL;
