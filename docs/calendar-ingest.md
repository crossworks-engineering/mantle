# Calendar ingestion — design

**Status:** Built — migration `0104_calendar_accounts` pending apply. ICS provider shipped; Google/Microsoft OAuth providers are future work.
**Author:** drafted 2026-06-24

A **provider-agnostic calendar pipeline**: sync any external calendar into
Mantle's events so they're searchable, show in the events UI, and feed the
knowledge graph. The first (and universal) provider is **ICS** — an iCalendar
feed URL — which covers Google, Outlook, Apple, and CalDAV without OAuth. The
Microsoft-Graph calendar (the held M3 of the Graph integration) and a Google
Calendar API provider implement the same interface later.

## Why ICS first

An iCal feed URL is the one calendar integration that works *everywhere*:
- **Google** — Settings → *your calendar* → "Secret address in iCal format"
- **Outlook/M365** — Publish calendar → ICS link
- **Apple iCloud** — Public calendar share → `webcal://…`
- **CalDAV / Fastmail / Nextcloud** — the calendar's `.ics` export URL

Read-only, no OAuth, no admin consent — so it ships value immediately while the
richer OAuth providers (write-back, faster delta, attendee status) come later
behind the same seam.

## Architecture

The shape mirrors the email pipeline (provider interface + orchestrator) and
reuses Mantle's existing **event nodes** as the storage target — synced events
are ordinary `type:'event'` nodes, so the events UI, reminders surface, search,
and extractor all work unchanged.

```
CalendarProvider.pull(account) → CalEvent[]   (ICS: full set; API: delta)
        │
syncCalendarAccount (orchestrator)
        │  upsert confirmed → event nodes (dedup by external_uid)
        │  reconcile deletions (absent-from-full-set, or status=cancelled)
        ▼
@mantle/content upsertExternalEvent → nodes(type='event', data.external_*)
        │  INSERT fires node_ingested → extractor → summary + embedding + facts
        ▼
events UI · search · knowledge graph
```

### Package: `@mantle/calendar`

```
packages/calendar/src/
  types.ts            ← CalendarProvider interface, CalEvent, CalendarPull
  providers/ics.ts    ← ICS feed: fetch → ical.js parse → expand recurrence → CalEvent[]
  sync.ts             ← syncCalendarAccount: upsert + reconcile + persist cursor
  manage.ts           ← addIcsFeed / list / enable / delete (owner-scoped)
```

A provider returns either the **full set** (ICS — the orchestrator deletes
stored events whose uid is absent) or a **delta** (API providers — removals come
as `status:'cancelled'`). That one flag lets one orchestrator serve both models.

### Storage: event nodes + provenance (`@mantle/content`)

`upsertExternalEvent(ownerId, …)` creates/updates an `event` node, dedup by
`(owner, data.external_account_id, data.external_uid)`. Synced events carry
provenance in `data` (`external_uid`, `external_account_id`, `external_source`,
`all_day`) and **suppress the Mantle reminder** (`reminder_sent_at` stamped) —
the source calendar already notifies, so we don't double-ping. Re-extract
(re-embed) only fires when title/time/location/body actually change.

### Recurrence

Recurring series are **expanded into individual occurrences** within a bounded
window (~30 days back, ~13 months forward; capped per-series and total) by the
ICS provider, each its own event node keyed `<uid>:<occurrenceStart>`. This
avoids fighting the reminder worker's single-row roll-forward (built for
Mantle-native recurring events) and matches what the user sees in their
calendar. The external calendar stays authoritative; each sync re-expands and
upserts.

### Schema (`calendar_accounts`, migration 0104)

Owner-scoped list of subscribed calendars. `provider` ('ics' now), sealed
`feed_url_enc` (Google's secret address is a credential — sealed with
`@mantle/crypto`, AAD = row id), `enabled` (opt-in), `sync_state` (delta cursor
for API providers; ICS leaves it empty), `last_sync_at` / `last_event_count` /
`last_sync_error` for the UI. Plus a partial index on
`nodes(owner_id, (data->>'external_uid'))` for fast dedup.

### Worker + UI

- `apps/web/workers/calendar-sync.ts` — pg-boss, scheduler every 2 min →
  one single-flight sync per enabled calendar (+ `worker_calendar` compose
  service, `worker:calendar:dev` script).
- `/settings/calendar` — subscribe by name + iCal URL, enable toggle, delete
  (unsubscribe removes its synced events). Nav entry "Calendars".

## Adding an OAuth provider later (Google / Microsoft)

1. Add token columns to `calendar_accounts` (or reuse `ms_accounts` for the
   Graph one) + a `provider` value.
2. Implement `CalendarProvider.pull` over the provider's delta API, returning
   `fullSet:false` with `status:'cancelled'` tombstones and a `nextCursor`.
3. Register it in `sync.ts`'s `providerFor`. Nothing downstream changes.

For Microsoft specifically, this is the held **M3** of the Graph integration —
it becomes "implement `CalendarProvider` for Graph `/me/calendarView/delta`",
reusing the `ms_accounts` OAuth token, exactly as Outlook mail reused the email
pipeline.

## v1 simplifications (noted for later)

- ICS only (OAuth providers are future work).
- Recurrence expanded to a bounded window; very long horizons truncate (capped).
- Complex RRULEs are honored via `ical.js` expansion, but exceptions/overrides
  (EXDATE/RECURRENCE-ID edits) follow ical.js's handling — spot-check against a
  real Google/Outlook feed during testing.
- Synced events don't fire Mantle reminders (source calendar owns
  notifications); revisit if users want Mantle-side reminders on synced events.
- Editing a synced event in Mantle's UI is overwritten on the next sync (it's a
  mirror of the source).
