---
title: Tools
toolGroups: [toolsmith]
---

## Tools

The registry of atomic capabilities. Every single thing any agent can do is a
row here, reading a note, querying a table, sending mail, calling an external
API.

A tool on this screen is **not granted to anyone**. This is the catalogue, not
the permission system: agents receive capability through tool groups, and a tool
nobody has bundled into a group is inert no matter what its row says.

Two switches on a row matter. **Enabled** takes a tool out of circulation
everywhere at once, the emergency brake. **Requires confirmation** routes every
call through the pending-approvals queue, so the tool still works but never runs
unseen.

## Assistant

- "What tools can you actually use right now?"
- "Build me a tool that calls the weather API."
- "Test the invoicing tool with order 4471."

Authoring new HTTP tools is real work the toolsmith specialist does: it reads
the API's documentation, writes the request template, tests it against the live
endpoint, and can put it in a group. What it hands back is a capability that
didn't exist before.

Built-in tools can't be rewritten this way, only their enabled and confirmation
flags are editable, and shell tools are off-limits to agents entirely.

## Technical

Three kinds share the registry. **Builtins** are compiled into the app.
**HTTP** tools are data: a URL, method, header/query/body templates with
placeholder substitution, stored on the row. **Shell** tools run commands and
are deliberately not agent-editable.

An HTTP tool's credentials are never stored on the tool. The templates carry a
placeholder that resolves against the sealed key vault at call time, so the tool
definition is safe to read, copy and share while the secret stays sealed. That
separation is why an agent can be trusted to author a tool at all.

The confirmation flag is enforced in the tool loop, upstream of dispatch: a
gated tool writes a pending row and the turn continues without a result. There's
no path where an agent reasons its way past it, because the check happens before
the code that would run the tool.

Slug squatting is blocked, an agent cannot mint a tool whose name shadows a
builtin, which would otherwise be a way to intercept calls meant for the real
one. And an approval requirement set by you outranks the agent's own preference
when it creates a tool.
