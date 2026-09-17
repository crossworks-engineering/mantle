---
title: Profile
toolGroups: [profile]
---

## Profile

Your own preferences, timezone, locale, and which agents are allowed to send
you reminders.

Timezone is the one that quietly matters most. It decides what "tomorrow
morning" means when you ask for a reminder, when a heartbeat's quiet hours
start, and how every date in the app is rendered. Get it wrong and nothing
errors; things just happen at odd times.

The sample below the setting is computed live from your choices, so you can
confirm the format is what you expected rather than discovering it later in a
reminder.

## Assistant

- "I'm in Cape Town this month, update my timezone."
- "Remind me on Friday morning to send the invoice."

Changing timezone in conversation is deliberately possible, because the moment
you most need it changed is while travelling, and a wrong clock silently
mis-times every reminder you set from that point on. It's the only profile
setting the assistant can adjust.

## Technical

Times are stored as absolute instants and rendered in your zone, so changing the
zone re-renders history rather than rewriting it. An event you created at 09:00
in one zone still refers to the same moment after you move; it just displays
differently.

Reminder permission is per agent, not a global switch. An agent not on the list
can compute that something is due and cannot notify you about it, which is how
a specialist stays useful without acquiring the ability to interrupt you.

The zone also feeds heartbeat gating. A heartbeat with quiet hours and no zone
of its own inherits this one, so setting your profile correctly is what makes
"don't message me at night" mean your night.

Locale affects formatting only, date order, number separators, first day of the
week. It doesn't change the language the assistant replies in; that follows the
language you write in.
