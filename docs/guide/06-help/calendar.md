---
title: Calendars
toolGroups: [events]
---

## Calendars

Subscriptions to external calendars by ICS link, a work calendar, a shared
family one, a booking system's feed.

These are **read-only**. A subscribed calendar's events appear alongside your
own and the assistant can reason about them, but nothing Mantle does writes back
to the source. If you need to change one of those events, you change it where it
lives.

That's a deliberate boundary rather than a missing feature: an ICS subscription
URL is a publishing endpoint, not an editing API, and pretending otherwise would
produce edits that silently vanish at the next sync.

## Assistant

- "What's on this week?"
- "Am I free Thursday afternoon?"
- "Book the site visit for Tuesday at nine."

Worth knowing which calendar a new event lands in. The assistant creates events
in *your* calendar, never in a subscribed one, so "move the dentist appointment"
works if you made it and doesn't if it arrived from a feed.

## Technical

Each feed is polled on a schedule and reconciled: events that changed are
updated, events that vanished from the feed are removed. Because the feed is the
source of truth, local edits to a subscribed event would be overwritten, which is
the mechanical reason they're not allowed.

Subscribed events are stored as ordinary event nodes tagged with their source
feed, so they're searchable and embeddable like your own. The distinction lives
on the node rather than in a separate table, which is what lets a single "what's
on this week" query span both.

A feed that stops responding leaves the last successfully synced events in place
rather than deleting them. A dead link is far more often a temporary outage than
a cancelled year, and silently emptying your calendar would be the worse failure.

The URL is stored as given. Most providers' "secret address in iCal format" links
are credentials in their own right (anyone with the URL can read the calendar) 
so treat one like a password when copying it around.
