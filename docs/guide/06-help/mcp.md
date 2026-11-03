---
title: MCP connector
---

## MCP connector

The MCP connector lets an outside AI client, such as Claude or ChatGPT, connect to this brain and use its tools. It is off until you turn it on.

1. Switch on **Enable remote MCP**.
2. Copy the **Connector URL**.
3. In Claude (web or desktop), open Settings, then Connectors, then Add custom connector, and paste the URL. For Claude Code, copy the command under **How to connect**.
4. Sign in to this brain with your own login and approve access when asked.

ChatGPT (Business, Enterprise or Edu, on the web) uses the same URL:

1. A ChatGPT workspace admin opens Plugins, presses +, then Add custom MCP server, and pastes the URL.
2. They choose OAuth, sign in to this brain and allow access.
3. They publish the app for the ChatGPT workspace. Each person then signs in once with their own login.

ChatGPT sees only what the signed-in login can see, and what a tool returns goes into the company's OpenAI workspace. After a MantleOS update, a ChatGPT admin presses Refresh on the app. See [Connect ChatGPT over MCP](../07-api/09-connect-chatgpt.md).

Click **Check endpoint** to test that the connector answers. **Connected clients** lists every client that has signed in. **Disconnect** cuts its access at once. A ChatGPT app is one client for its whole ChatGPT workspace, so disconnecting it cuts everyone there.

Every login uses MCP with its own rights only, and changes rows in a mini app only where the app's **MCP access** is on. A client that cannot sign in uses a key from **API access**, sent as a header.

Outside the Admin workspace, this screen shows your own view: the URL, how to connect, the **Data sources you can use** and **Your connected clients**.

> **Using ChatGPT well**
>
> ChatGPT asks you to allow every write call, so many small writes mean many clicks.
>
> - Ask for one batch call, such as "change these rows in one `table_rows_upsert` call" or "make these page edits in one `page_blocks_apply` call".
> - Upload files in the MantleOS web app, then refer to them by name.
> - Build apps in the MantleOS chat, or in a client that has "Always allow". An app takes many write calls.
> - Deleting rows has no batch call, so each deleted row asks once.

## Assistant

This screen has no assistant tools. Set it up here, then talk to your brain from the outside client.

## Technical

- Clients sign in with OAuth. The URL alone grants nothing.
- Admin tools are listed only where the login is in the Admin workspace.
- The shell tool `run_terminal` is off over the network unless the server sets `MANTLE_MCP_TERMINAL=1`.
- The tool list starts with the tools that change things: writes, deletes, sends, then reads.
- The tool map is a short tool list: the core reads, `tool_help`, and four call tools by risk (`tool_read`, `tool_write`, `tool_delete`, `tool_send`). Add `?tools=map` to the URL, or set `MANTLE_MCP_TOOL_MAP=1` on the server. Only `tool_read` is safe to always allow; let the other three ask each time. A client that remembers the full list can still call a tool by its old name. See [Connect Claude over MCP](../07-api/01-connect-claude.md#list-fewer-tools-the-tool-map).
- Every tool call over MCP is logged, one row per call, with secrets taken out. Each login reads only its own rows (`GET /api/mcp-calls`). An admin cannot read another login's rows either. Rows are removed after 90 days.
- A client running on the server itself can use the local stdio transport instead. See [Connect Claude over MCP](../07-api/01-connect-claude.md).
