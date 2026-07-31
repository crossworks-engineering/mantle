---
title: Events
toolGroups: [events]
---

## Events

Calendar entries — one-off or recurring — with optional reminders that reach you
on Telegram.

Two kinds live here. Events you create in Mantle, which it owns and can change;
and events from subscribed calendars (Settings → Calendars), which are read-only
copies of a feed someone else controls.

## Assistant

- "Put the site inspection in for Tuesday at 9, remind me an hour before."
- "What's on this week?"
- "Move Thursday's meeting to Friday."

Ask about your week in plain language rather than by date — it resolves
"tomorrow", "next Tuesday" and "the week after" against your profile timezone.

## Technical

Events are nodes with start/end timestamps, recurrence, and a reminder offset.
Reminders are delivered by a worker that wakes on schedule and sends through your
configured channel — so a reminder only arrives if that worker is running, which
is worth remembering on a local stack.

Subscribed calendars sync over iCal on a timer. That direction is strictly
read-only: nothing Mantle does is written back to the upstream calendar, so
editing a synced event locally would be overwritten on the next sync.

Times are stored with timezone information and rendered in your profile
timezone, which is why a mismatch there shows up as everything being off by a
fixed number of hours.
