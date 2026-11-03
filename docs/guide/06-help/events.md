---
title: Events
toolGroups: [events]
---

## Events

Events is your calendar: one-off or repeating entries, with an optional reminder.

- Click **New** and fill in **Title**, **Starts** and, if you like, **Ends**, a **Location**, **Tags** and **Notes**.
- Set **Repeat** (daily, weekly, monthly or yearly, with an optional **Until**) for a recurring event.
- Set **Remind** to get a message before it starts: at start, 5 or 15 minutes, 1 hour or 1 day before.
- Events sit in folders. Search finds events and folders by name.
- An open event has **Add to calendar**, which downloads it as an `.ics` file.

## Assistant

- "Put the site inspection in for Tuesday at 9, remind me an hour before."
- "What's on this week?"
- "Move Thursday's meeting to Friday."

Say "tomorrow" or "next Tuesday". The assistant reads dates in your profile timezone.

## Technical

- Events are nodes with a start, an end, a repeat rule and a reminder time.
- A background worker checks for due reminders every 30 seconds. It sends them on Telegram or in the mobile app, following whichever you last used to message the assistant. If no Telegram chat is paired, the reminder waits until one is.
- Times show in your profile timezone. If every event is off by the same few hours, check the timezone on the Profile screen.
- Tools: `event_list`, `event_get`, `event_create`, `event_update`, `event_delete`.
