---
title: Studio
---

## Studio

The overview editor for the whole agent graph, who delegates to whom, which
skills hang off which agent, which tool groups grant what, and how it all
composes into the prompt a model actually receives.

The settings screens let you dive into one thing and edit it deeply. Studio
lets you stand back and see the **wiring**. It's the same underlying rows, read
the other way round.

Its governing rule is worth stating outright: **no hidden prompts.** Wherever an
instruction is given as human-written prose, it must be visible here, including
its composition. The composed-prompt preview shows the assembled text, the
agent's own prompt plus each attached skill, in order, which is the only place
in the system that answers "what did the model literally read?"

## When to use this

Come here when behaviour is wrong and you can't see why from any single screen.
The usual answer is in the composition rather than in any one part: a skill
teaching something that contradicts the prompt, a delegate that was never wired,
a group granted to the wrong agent.

Use the sandbox before saving. It runs a real multi-turn conversation against
the composed prompt and **persists nothing**: no messages, no memory, no
extraction. It's the way to find out whether a prompt edit helped without
putting the result into your brain.

Prompt edits are versioned with a history, a diff and a revert. Edit freely;
going back is one click.

## Technical

The canvas is drawn from the live database rows, not from the manifest, so it
shows your brain as it is, including everything you've changed. The manifest is
the factory default, and the integrity check is the linter that lights each node
and edge against it.

Tool groups appear as their own nodes with grant edges into agents, which makes
the capability question visual: every path from a tool to an agent is a drawn
line. Skill nodes read as teaching and have no such edges, because skills carry
no tools.

Structure editing here writes the same rows the settings screens write, model,
parameters, attached skills, delegates, with a reset-to-default that pulls the
manifest's version of that one item.

Prompt versions are stored per agent, so history survives model changes,
re-grants and anything else you do around them.
