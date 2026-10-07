---
title: MCP connector
---

## MCP connector

The MCP connector lets an outside AI client, such as Claude, connect to this brain and use its tools. It is off until you turn it on.

1. Switch on **Enable remote MCP**.
2. Copy the **Connector URL**.
3. In claude.ai, open Settings, then Connectors, then Add custom connector, and paste the URL.
4. Sign in to this Mantle and approve access when asked.

Click **Check endpoint** to test that the connector answers. **Connected clients** lists every client that has signed in. Disconnect one to cut its access at once.

Under **Team and client access**, let a member or client use Claude on this brain with their own rights only. They are read-only unless you turn on Write, which lets them make drafts in their own space. A member or client whose client cannot sign in makes their own key under **API access**. Tokens you made before still work and can be revoked here.

## Assistant

This screen has no assistant tools. Set it up here, then talk to your brain from the outside client.

## Technical

- Clients sign in with OAuth. The URL alone grants nothing.
- As the owner, a client gets every tool an agent can be granted. Members and clients get only what their own rights allow.
- The shell tool `run_terminal` is off over the network unless the server sets `MANTLE_MCP_TERMINAL=1`.
- A client running on the server itself can use the local stdio transport instead. See [Connect Claude over MCP](../07-api/01-connect-claude.md).
