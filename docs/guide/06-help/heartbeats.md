---
title: Heartbeats
---

## Heartbeats

How the assistant acts **without being asked**. A heartbeat is a standing
instruction with a schedule, a memory, and a stop condition.

The memory is the part that makes it more than a cron job. A heartbeat carries
state across firings, so "get to know the user" can ask one question today,
remember the answer, and ask a different one next week, rather than repeating
itself forever. It stops when its own goal is met, not when a counter runs out.

Each heartbeat names an agent (whose voice), a skill (what to do), a schedule
(when) and a surface (where the message lands, a chat, or the web inbox).

## Before you change anything

The gates matter more than the schedule. **Quiet hours** stop it messaging you
at night. **Minimum idle** skips a firing if you've just been talking anyway.
**Cooldown** sets the floor between two firings of this particular heartbeat.
All three are per-heartbeat and default to nothing; a null gate means no check
of that kind, so a heartbeat with no gates configured will fire exactly on
schedule whatever else is happening.

There are no system-wide defaults. If you want quiet hours, you set them on each
heartbeat that should respect them.

A firing costs a model call whether or not it produces a message. A frequent
heartbeat on an expensive agent is a real line on the spend graph.

## Technical

Every fire attempt is recorded, including the ones that were gated and never
ran, so "why didn't it message me?" has an answer that distinguishes "the
schedule didn't come up", "quiet hours blocked it" and "it ran and decided not
to say anything".

The fire count only advances on successful runs, while the last-fired timestamp
updates on every attempt including errors. That pairing is what lets a
max-fires limit mean "do this five times" rather than "try this five times".

Agent and skill are resolved by slug at fire time, not stored as ids. Rename or
replace either and the heartbeat follows the new one; delete it and the firing
soft-fails and is logged rather than taking the scheduler down.

The control tools a heartbeat skill uses to mark itself complete are granted by
the fire path itself, not through a tool group, which is why you won't find
them in a bundle on the tool-groups screen.
