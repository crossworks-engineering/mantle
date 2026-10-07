---
title: Tool groups
toolGroups: [toolsmith]
---

## Tool groups

A tool group is a named bundle of tools you grant to an agent in one step. An
agent can use exactly the tools in the groups it holds, and nothing else. To
know what an agent can do, read its groups.

The built-in groups are cut where the risk changes. Reading tables, writing
rows, building grids and deleting a table are four separate groups, so an
agent can answer questions about your data all day and never change a cell.

- **New** creates a group: a **Name**, a **Slug** (fixed once created) and the
  **Tools in this group**.
- Each group has a level (Admin, Team, Client or Public). An agent may hold a
  group only at a level it can read. Setting a group to Client or Public lets
  every tool in it run for clients or the public, so the screen asks first.
- An integration group stands for one outside API. It holds the base URL and
  the credential reference, and every tool added to it uses them.

Grant groups to agents in Settings > Agents.

## Assistant

- "Which tool groups does the researcher have?"
- "Make a group with the weather tools and give it to the assistant."

Name the agent and the group when you ask for a grant. These requests go to
the Toolsmith specialist.

## Technical

Groups are flat: a list of tool slugs, never groups inside groups. Skills carry
no tools, so attaching a skill changes how an agent works, never what it can
reach. The default groups come from the system manifest; your own groups sit
beside them. When an agent changes the tools of a group below Admin level, the
change waits for your approval in [Pending approvals](pending.md). The Toolsmith uses
`tool_group_list`, `tool_group_ensure`, `agent_list` and
`agent_grant_tool_group`; an agent cannot grant a group to itself.
