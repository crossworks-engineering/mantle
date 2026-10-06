---
title: Tools
toolGroups: [toolsmith]
---

## Tools

This is the list of every action an agent can take: reading a note, querying a
table, sending mail, calling an outside API. A tool here is granted to nobody.
Agents get tools only through [tool groups](tool-groups.md).

Two switches matter on each tool:

- **Enabled**: off takes the tool away from every agent at once.
- **Requires operator confirm**: every call waits in [Pending
  approvals](pending.md) until you approve it.

**New** adds an HTTP tool (a request template) or a shell tool (a command
template). Built-in, recipe and connector tools are read-only here apart from
those two switches.

Two policy switches sit on the same screen. **Require my approval for
agent-built tools** holds each call of a tool an agent wrote. **Approve email &
web during unattended heartbeats** holds sends and web fetches when a
heartbeat fires while you are away.

## Assistant

- "Build me a tool that calls the weather API."
- "Test the invoicing tool with order 4471."
- "Which tools are in the email group?"

These requests go to the Toolsmith specialist. It reads the API's
documentation, writes the request template, tests it against the live API and
can put the tool in a group. Agents can author HTTP tools only; shell tools are
yours alone.

## Technical

Tool kinds are builtin, http, shell, recipe (a chain of other tools) and mcp
(mirrored from a connector). An HTTP tool stores no credentials: its templates
hold a `{{secret:service/label}}` reference that is filled from the encrypted
key vault at call time, so the tool can be read and shared while the key stays
sealed. The confirm check runs in the tool loop before the tool
executes, so no agent can talk its way past it. The Toolsmith uses
`api_tool_create`, `api_tool_update`, `api_tool_test` and related tools.
