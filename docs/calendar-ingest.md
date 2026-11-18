# Calendar feeds (the Sync service)

Any calendar with an iCal address (Google's secret address, Outlook's
published ICS, iCloud, Fastmail, CalDAV) can be linked in Settings > Sync as
a feed (Sync plan M2, [services.md](./services.md) "Sync"). Read-only.
Before M4 a brain worker pulled them; that design is in
[\_archive/calendar-ingest.md](./_archive/calendar-ingest.md).

## A run of a feed

Every 30 minutes, one feed at a time, the sidecar:

1. fetches the feed through the one egress fetch (every hop checked: a feed
   or a redirect into private or metadata space is refused; 12 MB at most;
   `webcal://` is https);
2. parses it with ical.js and expands each recurring event into its
   occurrences, from 30 days back to about 13 months ahead (400 per series,
   5000 per feed at most); a cancelled event is left out;
3. posts the complete set: `POST /api/sidecar/events`. The brain upserts
   each as an ordinary event node (`upsertExternalEvent`, keyed by the feed
   and the event's UID; the feed's name as a tag; no reminder of its own,
   the source calendar owns those) and removes the feed's events that left.

Events are brain data: they show in Calendar, search and the graph like
any event, and stay when Sync is off. Removing a feed removes its events.

The feed's URL can carry a secret, so it is sealed in `service_state` and
never shown again (an edit may replace it) or written in a log or status.
