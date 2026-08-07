---
title: Skills
toolGroups: [toolsmith]
---

## Skills

Prose that teaches an agent how to do something well. How to phrase a voice
reply, how to structure a page edit, when to hand work to a specialist, how to
quote a calculation's working.

A skill is **teaching only**. It confers no capability whatsoever, an agent
with a page-editing skill and no page tools will explain page editing very well
and be unable to do any. This is the single most useful thing to know about this
screen, because the intuition runs the other way.

Skills are composed per turn rather than baked in, so editing one changes
behaviour on the next message with no restart. Workers can hold them too, which
is how a summarizer learns your preferred shape for a summary.

## Assistant

- "What skills does the persona have?"
- "Write a skill that teaches you how we word quotes."

Because a skill is just prose, this is one of the safer things to let the
assistant author; the worst outcome is advice that doesn't help, not an action
you didn't expect.

## Technical

A skill row carries instructions and nothing else. The column that used to
carry tool slugs was dropped outright, along with the code that unioned it into
an agent's capability, so there is no longer any way for teaching and
permission to be confused.

That split is what makes the composed prompt readable. At turn time the agent's
own prompt and its attached skills are assembled in a fixed order, and Studio
can show you the exact text the model received; nothing is injected behind your
back.

Because skills are prose and versioned, Studio keeps their history with a diff
and a revert, the same way you'd treat any other text you care about getting
right.

The default skills ship in the system manifest and are reconciled on upgrade, so
a brain that's been running for a year gets new teaching as it's written.
Skills you author yourself are yours and are never overwritten.
