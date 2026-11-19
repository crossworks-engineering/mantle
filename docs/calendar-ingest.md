# Calendar feeds (the Sync service)

Any calendar with an iCal address (Google's secret address, Outlook's
published ICS, iCloud, Fastmail, CalDAV) can be linked in Settings > Sync as
a feed (Sync plan M2, [services.md](./services.md) "Sync"). Read-only.
Before M4 a brain worker pulled them; that design is in
[\_archive/calendar-ingest.md](./_archive/calendar-ingest.md).

## A run of a feed

Every 30 minutes, one feed at a time, the sidecar:

1. streams the feed through the one egress fetch (every hop checked: a feed
   or a redirect into private or metadata space is refused; 512 MB at most;
   `webcal://` is https);
2. parses it in parts as it arrives, one VEVENT at a time with the feed's
   VTIMEZONEs (ical.js), so a feed of any size keeps flat memory. A single
   event is taken whatever its date. A recurring event is expanded into
   its occurrences from its first one through about 13 months ahead: the
   horizon is pacing (an open-ended rule has no last occurrence; each run
   reaches further), never a drop, and a past occurrence stays. A changed
   occurrence (RECURRENCE-ID) replaces the plain one; a cancelled event or
   occurrence is left out. A rule past 50 000 occurrences before the horizon
   is cut there, and the run says so. Descriptions go whole up to 20 000
   characters and titles up to 1000 (the brain's bounds); text past them is
   cut and the status counts it. A changed or cancelled occurrence's key is
   kept for the next run (`feedkeys:`, hashed), so its plain occurrence is
   not written over the change on every run;
3. posts the events in pages (`POST /api/sidecar/events` with `partial`:
   1000 events or 8 MB a page). The brain upserts each as an ordinary event
   node (`upsertExternalEvent`, keyed by the feed and the event's UID; the
   feed's name as a tag; no reminder of its own, the source calendar owns
   those);
4. only after a run that read every event and posted every page, asks the
   brain for the feed's stored uids (`GET /api/sidecar/events?feedId=`) and
   removes the ones this run did not post (`remove`, in pages). A run that
   stopped part way or cut anything removes nothing but the occurrences the
   feed itself cancelled, and its status says what was not taken in. A body
   that is no iCalendar document (a sign-in page, an empty answer) or ends
   before its `END:VCALENDAR` is such a cut. The stored set is asked first:
   a brain from before pages (no GET) is never posted to.

Events are brain data: they show in Calendar, search and the graph like
any event, and stay when Sync is off. Removing a feed removes its events.

The feed's URL can carry a secret, so it is sealed in `service_state` and
never shown again (an edit may replace it) or written in a log or status.
