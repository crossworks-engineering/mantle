# Heartbeats — proactive behaviour

By default the assistant is reactive: it waits for you. **Heartbeats** make it
proactive — standing instructions that fire on a schedule, remember progress across
runs, and stop themselves when their job is done. Configure them under
**Settings → Heartbeats**.

## What a heartbeat is

A heartbeat ties together:

- **A schedule** — once at a time, on an interval ("every Monday 8am"), or
  manual/on-demand.
- **A skill + agent** — what to do, and who does it (using the agent's normal tool
  loop, so it can search, write, email, etc.).
- **A surface** — where its message goes (Telegram or the web).
- **Persistent state** — a little memory it carries between fires (e.g. "already
  asked about X", "expecting a reply").
- **A stop condition** — `max_fires`, or the skill calling "complete" when the goal
  is met.

## It won't pester you

Heartbeats have **guards** so they stay polite:

- **Quiet hours** (e.g. 22:00–07:00) — no firing overnight.
- **Idle / cooldown** — wait for a lull, and don't fire again too soon.
- **Earliest time** — don't start before a given moment.

The settings form offers a sensible-defaults preset, or you can set each guard (or
leave it off). Gate-skipped fires are logged but don't burn through `max_fires`.

## How a conversation stays coherent

If a heartbeat asks you something and you reply an hour later, that reply hits the
*normal* assistant — which is made aware there's an open heartbeat and responds in
character, updating the heartbeat's state (or completing it) as appropriate. So a
proactive nudge and your eventual answer feel like one continuous conversation, not
a robot talking past you.

## Example: "get to know you"

The bundled `get_to_know_user` heartbeat fires **once**, a few hours after setup,
with a single warm question — then completes itself as soon as you reply
substantively. (An earlier multi-day interrogation design was scrapped: the system
already learns you passively as you use it, so one good opening question beats a
CRM-style questionnaire.) It's the template for "ask once, learn, stop."

Other natural uses: a Monday "weekly review" routine, a daily standup prompt, or
"keep reminding me about X until I've dealt with it."

## Managing them

- **Settings → Heartbeats** — create, edit, pause/resume, delete, and **fire now**.
- **Each heartbeat's detail page** — its current state, guard summary, and a log of
  recent fires (with links into [Traces](../05-technical/02-observability.md) so you
  can see exactly what happened).

## A safety note

Heartbeats are the one feature that can make the assistant act on its own schedule,
so they're built to be **bounded by construction**: every fire is gated, logged,
and counted, and heartbeats end themselves. There's deliberately no way to create a
runaway loop that spends without limit. If you build a custom heartbeat, give its
agent only the tools it needs (see [Skills & tools](02-skills-and-tools.md)).
