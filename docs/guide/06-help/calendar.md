---
title: Calendars
toolGroups: [events]
---

## Calendars

Calendars subscribes to outside calendars by their iCal (.ics) link, so their events show up in Events.

1. Under **Subscribe to a calendar**, enter a **Name**, for example "Work calendar".
2. Paste the **iCal URL**. In Google Calendar it is the "Secret address in iCal format". In Outlook, publish the calendar and copy the ICS link.
3. Click **Subscribe**. The first sync runs within two minutes.

Each row shows the event count and the last sync time. Use the sync button to pull now.

Subscriptions are read-only. Nothing is written back to the source, and an edit made in Mantle is overwritten at the next sync. Change those events where they live.

## Assistant

- "What's on this week?"
- "Am I free Thursday afternoon?"
- "Book the site visit for Tuesday at nine."

New events the assistant makes go into your own calendar in Events, not into a subscribed one.

## Technical

- Every enabled calendar syncs every two minutes.
- Synced events are normal event nodes, tagged with the calendar's name. Events removed from the feed are removed here.
- If a sync fails, the last good events stay and the row shows the error.
- Synced events get no Mantle reminder. The source calendar sends its own.
- A secret iCal link lets anyone who has it read the calendar. Treat it like a password.
