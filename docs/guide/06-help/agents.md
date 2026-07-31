---
title: Agents
toolGroups: [toolsmith]
---

## Agents

The reasoners. An agent has a persona, a model, a set of tool groups, skills,
and — if you let it — other agents it can delegate to. Everything that holds a
conversation is here.

The one to know is your **persona**: the assistant you actually talk to. The
others are specialists it hands work to — a researcher for web search, a
mathematician for calculations, a toolsmith for building new capabilities. You
don't converse with a specialist; the persona calls it and folds the answer back
into its own reply.

Two routes are configured per agent, not one. The **primary** is what it uses;
the **backup** is what it falls back to when the primary is unreachable. That's
what makes a local model viable as a primary — the cloud backup covers the
outage.

## Assistant

- "What agents do I have?"
- "Give the researcher access to my files."

The assistant can list agents and grant a tool group to one. It deliberately
cannot rewrite an agent's prompt or change its model from a conversation —
those are the settings that decide what the assistant *is*, and letting it edit
them mid-turn would make its behaviour unauditable.

For editing prompts with history and a diff, use Studio rather than this screen.

## Technical

An agent's capability is **exactly the union of its granted tool groups**.
There is no second channel: skills carry no tools, and the old direct
per-agent tool list was dropped. That single rule is what makes "why can this
agent delete pages?" a question with one answer rather than two places to check.

Skills are pure teaching — prose that shapes *how* an agent uses what it
already holds. Attaching a skill can never widen what an agent can reach. If a
capability is missing, the fix is always a group.

The primary/backup split lives in two sets of columns, and the active columns
are always the primary. "Make backup primary" swaps the values rather than
flipping a precedence flag, so the runtime has no ordering logic to get wrong —
it always tries the first set. A backup only counts as live when it is both
enabled and fully configured.

Deleting an API key doesn't delete the agents using it; the reference is
nulled, and the agent falls back to whatever resolution the provider allows.

The default agent graph — which specialists exist, what they're granted, who
delegates to whom — comes from the system manifest, so a fresh brain and an
upgraded one converge on the same shape. Changes you make here are yours and
survive; the manifest fills gaps rather than overwriting decisions.
