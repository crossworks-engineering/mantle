---
title: MCP connector
---

## MCP connector

The MCP connector lets an outside AI client, such as Claude, connect to this brain and use its tools. It is off until you turn it on.

1. Switch on **Enable remote MCP**.
2. Copy the **Connector URL**.
3. In claude.ai, open Settings, then Connectors, then Add custom connector, and paste the URL.
4. Sign in to this brain and approve access when asked.

Click **Check endpoint** to test that the connector answers. **Connected clients** lists every client that has signed in. Disconnect one to cut its access at once.

Every login can use Claude on this brain with its own rights only: it reads what its workspaces hold and changes what they let it change, and nothing more. There is no switch per login. It changes rows in a mini app only where the app's **MCP access** is on. A login whose client cannot sign in makes its own key under **API access**.

Outside the Admin workspace, this screen shows your own view: the connector URL, how to connect, what you read and change, the data sources you can use and the clients you connected. Disconnect one to cut its access at once. Only your own clients are listed.

> **Using ChatGPT well**
>
> ChatGPT asks you to allow every write call, so many small writes mean many clicks.
>
> - Ask for one batch call. Say "change these rows in one `table_rows_upsert` call", "add them with one `table_rows_add` call" or "make these page edits in one `page_blocks_apply` call".
> - Upload files in the MantleOS web app, then refer to them by name. ChatGPT often cannot pass a chat attachment through to MantleOS.
> - Build apps in the MantleOS chat, or in a client that has "Always allow". An app takes many write calls.
> - Deleting rows has no batch call, so each deleted row asks once.

## Assistant

This screen has no assistant tools. Set it up here, then talk to your brain from the outside client.

## Technical

- Clients sign in with OAuth. The URL alone grants nothing.
- Every login gets the same tools, each call in that login's workspaces. Admin tools are listed only where the login is in the Admin workspace.
- The shell tool `run_terminal` is off over the network unless the server sets `MANTLE_MCP_TERMINAL=1`.
- A client running on the server itself can use the local stdio transport instead. See [Connect Claude over MCP](../07-api/01-connect-claude.md).
