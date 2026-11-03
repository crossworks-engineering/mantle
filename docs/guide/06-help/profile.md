---
title: Profile
toolGroups: [profile]
---

## Profile

Your own settings for this brain. Change what you need and press **Save
profile**.

- **Photo** and **Avatar**: the picture shown for you. A photo wins over the
  generated avatar. With neither, your initials show.
- **Description**: who you are to the team, such as a job title or a role
  (up to 500 characters). It shows on your card next to your name, and
  everyone on this brain can read it, agents included, so they know whom to
  message. It saves on its own with **Save description**.
- **Site name** and **Peer name**: the names shown in the header, so you can
  tell brains apart.
- **Speciality** and **What this brain is for**: the brain's purpose. The
  second is added at the top of every conversation.
- **House style**: your writing rules, added to every agent's prompt.
  Speciality, purpose and house style are the brain owner's to set. Other
  logins do not see them.
- **Timezone (IANA)**, for example `Europe/London`. **Detect from browser**
  fills it in. It decides what "tomorrow morning" means, when reminders fire
  and how times are shown.
- **Locale (BCP-47)**, for example `en-GB`: how dates are written.
- **Reminder delivery** (Telegram or Mobile app) and **Event reminders from**
  (which assistant's Telegram bot sends them).
- **Live thinking & streaming** and **Thinking effort**: how replies appear
  while they are written, and how hard agents set to Inherit think before
  answering.
- **Sounds**: short, soft sounds for chat messages, a finished reply, an
  incoming call and other events. Off silences all of them, the call ring
  too. Set the **Volume**, and play each one under **Listen** (or **Play
  all**). Sounds save as you change them.

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

Your sounds and the layout of your **Desk** (the home screen) are saved on
your login too, so they follow you to another browser, machine or the
desktop app. Each save names the login it was made as, so a tab now signed
in as someone else cannot write over your settings.
