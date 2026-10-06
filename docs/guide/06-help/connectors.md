---
title: Connectors
---

## Connectors

Connectors lets your agents use tools from an outside MCP server. Each connector becomes a tool group you grant like any other.

1. Click **New**.
2. Enter a **Slug**, a **Name** and the **Server URL**. The tool group will be named `mcp-<slug>`.
3. Pick the **Authentication**: **None (public server)**, **API key from the vault**, or **OAuth (sign in via browser)**.
4. Click **Connect server** (or **Connect and authorize** for OAuth). The server's tools are synced once.
5. Click **Grant to an agent**.

Click **Sync tools** to pick up changes on the server. Nothing syncs on a schedule. If an OAuth sign-in expires, the connector shows "needs reconnect": click **Re-authorize**.

Some servers sign in through Microsoft. For those, set **Sign-in app** to the Microsoft app from the Microsoft screen. Your admin must add the callback URL shown here to that app.

This is the opposite of the MCP screen: there, outside clients reach into your brain. Here, your brain reaches out.

## Assistant

After you grant the group, ask the agent to use it, for example:

- "Use the weather connector to get tomorrow's forecast for my site."

Grant connector groups to a specialist that cannot write, not to your main assistant. Results from an outside server are marked as untrusted before a model reads them.

## Technical

- A connector is stored as a tool group. Its tools are named `mcp_<connector>_<tool>`.
- Calls time out after 25 seconds, and results are capped in size. Secrets are scrubbed from results.
- Keys and OAuth tokens are kept in the encrypted vault, never on the connector itself.
- A tool that disappears from the server is disabled, not deleted, so grants keep working if it returns.
- Deleting a connector removes its group, tools, tokens and grants.
