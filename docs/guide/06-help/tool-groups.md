---
title: Tool groups
toolGroups: [toolsmith]
---

## Tool groups

Named bundles of tools that you grant to an agent in one move, rather than
picking capabilities one at a time.

This screen is the whole permission system. An agent's capability is **exactly**
the union of the groups it holds; there is no other way for a tool to reach an
agent. If you want to know what something can do, you read its groups, and
you're done.

The bundles are cut where the risk changes, not where the feature boundary is.
Reading tables is one group, writing rows is another, authoring the grid is a
third, and deleting a table is a fourth. That looks fussy until you want an
agent that can answer questions about your data all day and physically cannot
change a cell — which is a normal thing to want.

## Assistant

- "What can the researcher do?"
- "Make a group with just the calendar read tools and give it to the team
  responder."

Granting is a real action with real consequences, so it's worth saying the
agent and the group explicitly rather than "give it what it needs".

## Technical

Groups are flat — a group is a list of tool slugs, and groups do not contain
groups. Nesting was rejected because the question this screen exists to answer
("what can this agent reach?") should never require walking a tree.

Skills carry no tools. That was true from the moment groups became the sole
grant, and it closed a real hole: previously a skill's bundled tool list was
silently unioned into the agent's, which could override a deny that had been set
deliberately. Now attaching a skill can only ever change *how* an agent works,
never *what it can touch*.

The default groups come from the system manifest, which is also what a
drift test in CI checks — so a group whose contents changed in code is caught
before it ships rather than discovered by an agent losing a capability. Your own
groups sit alongside them untouched.

Integration groups are a variant: a group that represents one external API,
carrying its base URL and auth placement so every tool added to it inherits
them, and optionally referencing a single skill that teaches its use. That's the
one case where a group carries configuration — still no behaviour of its own.
