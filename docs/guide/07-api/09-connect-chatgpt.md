# Connect ChatGPT over MCP

Add your brain to ChatGPT so ChatGPT can search and write your brain with the same tools Claude uses. It is the same connector URL and the same sign-in as [Connect Claude over MCP](01-connect-claude.md).

These steps follow OpenAI's help article "Connecting custom MCP servers in ChatGPT" and its MCP authentication guide, as they read on 2026-10-30. ChatGPT changes its menus often. If a name here does not match, follow OpenAI's article.

## Who can use it

- **ChatGPT Business, Enterprise and Edu**, on the web: read and write tools. Not on mobile.
- **ChatGPT Pro**: read and fetch tools only.
- In a Business workspace, only an admin or owner of the ChatGPT workspace adds and publishes the connector. In Enterprise and Edu, an admin can let chosen members add one, but only an admin or owner publishes it.

## Before you start

- The remote connector is on, and the connector URL works ([Connect Claude over MCP](01-connect-claude.md), "Turn on the connector").
- You have a MantleOS login for the setup. Its rights decide the tools ChatGPT finds when it scans.

## Add it to ChatGPT

The ChatGPT workspace admin does this:

1. In ChatGPT, open **Plugins**, press **+**, then **Add custom MCP server**.
2. Enter a name, such as the brain's name.
3. Under **Connection**, paste the connector URL exactly as **Settings > MCP** shows it. It looks like `https://example.com/api/mcp`. An older address of the brain may fail ChatGPT's check.
4. Under authentication, choose **OAuth**. ChatGPT finds the sign-in pages itself and registers itself. There is no client ID or secret to type.
5. Read the risk warning and tick the box.
6. Press **Create as a plugin**. ChatGPT opens the MantleOS sign-in. Sign in, type your password and press **Allow**.
7. Look at the tools ChatGPT found.

## Publish it for the workspace

Only a ChatGPT admin or owner publishes:

1. Open the ChatGPT **Admin console** and pick the workspace.
2. Open **Plugins**, then **Manage Legacy Apps**, then **Drafts**.
3. Press **Publish** and read the warnings for write actions.

In Enterprise and Edu, the admin can also pick which tools (actions) the app may use and which groups may use it, before or after publishing.

Each person then signs in once with their own MantleOS login, the first time they use the app. ChatGPT acts as that login.

## What the company must know

- **An admin publishes the connector.** Nobody else in a Business workspace can add it.
- **ChatGPT sees only what the login can see.** Each call runs as the signed-in login, in that login's workspaces, the same as in the browser ([MCP as a login](02-mcp-login.md)). A member gets no admin tools.
- **Tool results go to the company's OpenAI workspace.** What a tool returns becomes part of the ChatGPT conversation. From then on, OpenAI's terms for that workspace apply to it, not MantleOS's. In Enterprise and Edu, these conversations are in OpenAI's Compliance API.
- **The tool list is frozen when it is published.** ChatGPT keeps a copy of the tools it found. After a MantleOS update that changes a tool, a ChatGPT admin opens the app in workspace settings and presses **Refresh**. Until then, a changed tool can fail.
- **ChatGPT may ask before a write.** Tools that only read are marked as read-only. ChatGPT decides when to ask.

## The size of the tool list

An admin login lists 200 to 315 tools, depending on its Admin areas. A member lists fewer. OpenAI publishes no limit on the number of tools. If the tool scan fails or is slow:

- In Enterprise or Edu, switch off the actions the company does not need.
- Do the setup with a login that is in fewer workspaces or has fewer Admin areas.

## Disconnect

ChatGPT registers once for the whole ChatGPT app, so every person in that ChatGPT workspace signs in on one client in MantleOS.

- **A member** opens **Settings > MCP** in MantleOS and presses **Disconnect** next to ChatGPT. Only their own sign-in ends. They can sign in again from ChatGPT.
- **An admin** who presses **Disconnect** next to the ChatGPT client in **Settings > MCP** removes the whole client: the sign-in of every person in that ChatGPT workspace ends, and ChatGPT can no longer sign in with it. A ChatGPT admin must then add the connector again. To end only one person's access, end that login's sessions instead.
- A password change, **Sign out everywhere** or an admin's **End sessions** ends that login's sign-in only.

## A warning on the sign-in page

ChatGPT tells MantleOS which server the sign-in is for. When that is not this brain, the sign-in page shows **This sign-in names another server** with that server's name. The app could hand the access to that other server. Press **Allow** only if you trust that server with this brain. MantleOS does not refuse the sign-in, so older clients keep working.

## Fewer clicks

ChatGPT asks before every write call, and some plans only offer "Allow once". Ask for one batch call instead of many small ones (for example one `table_rows_upsert` for many rows), upload files in the MantleOS web app, and build apps in the MantleOS chat. The tips are in [Screen help: MCP](../06-help/mcp.md).

## If it fails

- **ChatGPT says it cannot reach the server**: open the connector URL in a browser. A 404 means the connector is off in **Settings > MCP**.
- **Sign-in works, but no tools show**: the tool scan may have failed on the size of the list. See "The size of the tool list" above.
- **Calls fail after a MantleOS update**: a ChatGPT admin presses **Refresh** on the app.

## Next

- [MCP as a login](02-mcp-login.md): every login connects with its own rights.
- [API keys](08-api-keys.md): for a script or a client that cannot sign in.
