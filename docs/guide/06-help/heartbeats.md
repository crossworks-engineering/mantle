---
title: Heartbeats
---

## Heartbeats

A heartbeat makes the assistant act without being asked. It is a standing job with a schedule, a memory and a stop condition.

1. Click **New** and give it a **Name**.
2. Pick the **Agent** (whose voice) and the **Skill** (what to do).
3. Set the schedule: every so many minutes, once at a set time, or manual only.
4. Choose the surface, where the reply goes: Telegram or the web.
5. Set the gates, when it may fire. New heartbeats start with sensible defaults: **Min idle** 15 minutes, quiet hours 22:00 to 07:00, **Cooldown** 30 minutes.
6. Save.

Use **Fire** to run it now, **Pause** or **Resume** to stop and start it, and the fire history link to see each attempt.

## Assistant

The assistant does not create heartbeats. Set them up here. While a heartbeat runs, its agent can save state, snooze or mark the job complete.

## Technical

- A heartbeat carries state between firings, so it can ask a different question each time and stop when its goal is met.
- Every attempt is recorded, including ones a gate skipped. The history shows whether a gate such as quiet hours blocked it, or it ran and chose not to message.
- The fire count only goes up on a completed run. **Max fires** counts completed runs.
- Agent and skill are looked up by slug at fire time. If either is deleted, the heartbeat pauses itself until you fix it.
- A run that passes the gates costs a model call even if it sends nothing.
- Its control tools (`heartbeat_complete`, `heartbeat_snooze`, `heartbeat_update_state` and others) come with the run itself, not from a tool group.
