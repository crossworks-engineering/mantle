---
title: Skills
toolGroups: [toolsmith]
---

## Skills

A skill is written guidance that teaches an agent how to do something well:
how to word a voice reply, how to edit a page, when to hand work to a
specialist.

A skill gives no abilities. An agent with a page-editing skill and no page
tools can explain page editing but cannot do it. Abilities come only from
[tool groups](tool-groups.md).

To add one, press **New** and fill in the **Name**, the **Slug** (fixed once
created), a one-sentence description and the **Instructions (markdown)**. Attach skills to agents in Settings > Agents or in
[Studio](studio.md). An edit takes effect on the agent's next message.

## Assistant

- "Write a usage skill for the weather tools you just built."
- "Which tool groups does the researcher have?"

The Toolsmith specialist writes the usage skill that travels with an
integration it built. Other skills you write here yourself.

## Technical

A skill row holds a name, a description and instructions, and nothing else.
At each turn the agent's own prompt and its attached skills are put together
in a fixed order; Studio shows the exact result. Studio also keeps each
skill's history, with a diff and a revert.

The default skills come from the system manifest. When Mantle is updated their
text is replaced with the shipped version, so an edit to a default skill does
not last; write your own skill instead. Skills you write yourself are never
overwritten. The Toolsmith writes integration skills with `api_skill_set`.
