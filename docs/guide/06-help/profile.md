---
title: Profile
toolGroups: [profile]
---

## Profile

Your own settings for this brain. Change what you need and press **Save
profile**.

- **Photo** and **Avatar**: the picture shown for you.
- **Site name** and **Peer name**: the names shown in the header, so you can
  tell brains apart.
- **Speciality** and **What this brain is for**: the brain's purpose. The
  second is added at the top of every conversation.
- **House style**: your writing rules, added to every agent's prompt.
- **Timezone (IANA)**, for example `Europe/London`. **Detect from browser**
  fills it in. It decides what "tomorrow morning" means, when reminders fire
  and how times are shown.
- **Locale (BCP-47)**, for example `en-GB`: how dates are written.
- **Reminder delivery** (Telegram or Mobile app) and **Event reminders from**
  (which assistant's Telegram bot sends them).
- **Live thinking & streaming** and **Thinking effort**: how replies appear
  while they are written, and how hard agents set to Inherit think before
  answering.

## Assistant

- "I'm in Singapore this week, update my timezone."
- "Set my timezone back to Africa/Johannesburg."

The timezone is the only profile setting the assistant can change. It tells
you what it changed.

## Technical

Settings are stored on your row in the `profiles` table. Times are stored as
absolute instants and shown in your zone, so changing the zone changes how
history is displayed, not the history itself. Heartbeat quiet hours without a
zone of their own use this one. The assistant changes the zone with
`set_timezone`.
