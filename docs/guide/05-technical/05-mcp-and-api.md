# MCP & API

> **Scope:** this page tells you these interfaces *exist* and how to reach them
> locally. It deliberately does **not** document individual calls, parameters, or
> responses — a dedicated **MCP & API explorer** is coming that will serve every
> call as live, always-current reference. Treat this as a pointer until then.

Mantle isn't only the web app. The same brain is reachable two more ways, primarily
for local/programmatic use.

## The MCP server

Mantle ships an **MCP (Model Context Protocol) server** that exposes your brain as
tools to MCP-capable clients — most usefully **Claude Desktop / Claude Code**. With
it connected, an external Claude session can search your memory, read and create
notes/files, work with contacts and the knowledge graph, manage Telegram, and more —
acting against your real data through a controlled tool surface.

It runs **locally** (a stdio server, attached at your MCP client's startup) and is
scoped to you as the single owner. You add it to your MCP client's configuration as
a local command; that's all that's needed to make your brain available inside Claude
Desktop/Code. It's there for when you want it — nothing depends on it for the app
itself to work.

## The HTTP API

The web app is backed by **HTTP API routes** that the UI uses, and that exist for
local/programmatic access to the same operations. They run as part of the app on your
own server.

## Why no call reference here (yet)

Documenting each tool and endpoint by hand would go stale the moment the code
changes. Instead, an in-app **MCP & API explorer** is planned that lists every
available call — names, inputs, outputs — straight from the live system, so the
reference is always accurate. When it lands, this page will link to it. Until then,
the takeaway is simply: **the MCP server and the API are available locally as
needed.**
