# MCP as a login

Let a team member, another admin or another Mantle use your brain from an MCP client, with that login's own rights and nothing more.

The connector URL is the same one the owner uses, and every login gets the same tools. Each call runs in the workspaces of the login that connected: it reads what those workspaces hold, and changes only what that login may change there. A login has no MCP permission of its own to switch on or off.

| Who connects      | How they prove it                                         | What they get                                               |
| ----------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| An admin          | Signs in at the connector URL, or sends their own API key | The tools, in their workspaces, held to their Admin areas   |
| A member          | Signs in at the connector URL, or sends their own API key | The tools, in their workspaces                              |
| A peer Mantle     | Its peer token, with **Acts as** set                      | The tools of the login it acts as, held to the peer's Write |

## Before you start

- The remote connector is on ([Connect Claude over MCP](01-connect-claude.md)).
- The person has a login and is a user of the workspaces they should reach ([Add logins](../05-admin/07-logins.md)).

## Let someone connect

1. Add them to the workspaces they should reach, as a user or a Moderator.
2. They add the connector URL to Claude and sign in with their own login.

That is all. What they may read and change follows from their workspaces, the same as in the browser. A member finds the connector URL and their connected clients in their own **Settings > MCP**, and can disconnect a client there.

A connection may write unless it is read only: a read-only API key, a peer with **Write** off, or a sign-in that was read only when the brain moved to one MCP for every login (it stays read only when it renews). Even then it changes only what the login may change in its workspaces: an item shared with Read only is refused.

Some tools are kept for the Admin workspace:

- A tool that manages the brain (assistants, tool groups, connectors, keys, settings) needs a user of the Admin workspace with that area switched on.
- A tool that spends on the brain owner's provider keys (a web search, an image, a summary, a crawl, a route map, a turn of another agent) is not offered to a login outside the Admin workspace.
- The Telegram inbox tools work for the brain owner only.

## Open a mini app's data to MCP

MCP sees no app data until you open an app to it.

1. Open the app and find **MCP access**, beside **Informational**.
2. Turn it on.

Who reaches the app is the same as in the browser, and the app must be published. An informational app is read only. A connection that may write may insert, update or delete rows in an app that is not informational. MCP never changes an app's tables or columns: the schema belongs to the app's author.

Copying or exporting an app with its data needs an edit right on the app, unless its **MCP access** is on.

Before the first MCP write to an app in an hour, the brain saves a snapshot of the app (**Before an MCP write** in the app's History). Restore it to undo. These snapshots keep a day of hours (24) on their own, so they never push out the app's other snapshots. Each MCP read and write shows in the app's Activity, and a write keeps its SQL. The SQL can hold what the member typed, personal data included: only admins see the Activity tab.

## Open an outside data source (a connector)

An MCP connector (Settings > MCP connectors) is a resource of a workspace. Every user of that workspace may use its tools over MCP; a tool that changes data needs a connection that may write and the resource's Write. Keep a source with secret parts in the Admin workspace only.

A tool you marked read-only (**I confirm this tool only reads data**) is a read. A tool without the mark changes data. Every call is logged with the login.

Removing the mark never closes a tool: it makes it a tool that changes data. To close one, take the connector out of the workspace or switch the tool off. If a connector's tool changes (its description or its inputs), the connector moves to another server, or it signs in another way (a new key, header, OAuth app, scope, or a sign-in as another account), its mark stops counting until you mark it again. A routine OAuth reconnect as the same account keeps the marks.

## When their MCP client cannot sign in

The person makes their own API key in **Settings > API access** and sends it as a header ([API keys](08-api-keys.md)). In Claude Code:

```sh
claude mcp add --transport http mantle https://example.com/api/mcp \
  --header "Authorization: Bearer mtlk_..."
```

A read-only key reads only. A key that was made for `/api/v1` before every login had MCP keeps working there and is refused on MCP: make a new one.

Admins no longer make tokens for other logins. Tokens made before (`mtlmcpk_...`) were all revoked when the brain moved to one MCP for every login; make an API key instead.

## Let a peer act as a login

1. Open **Settings > Peers** and pick the peer.
2. Set **Acts as** to a login.
3. Leave **Write** off unless the peer must change things.
4. List any extra tools under **Risky tools allowed**, for example `web_search`. Tools that spend, send or publish stay blocked until you name them, and a tool the login itself may not use stays blocked anyway.

Changing **Acts as** turns **Write** off again.

A peer with **Write** on may not change the content of a page or a note others read (one granted to a workspace other than Admin, or with a public link or a contact share), as an API key may not. The login changes it in the app.

## What ends access

- Removing the login from a workspace ends its reach there at once.
- Disabling the login, a password change, a role change or **Sign out everywhere** ends its sign-ins and API keys. A peer that acts as it goes back to acting as nobody. Its **Write** and risky tools are kept, so setting **Acts as** again restores it.
- The person disconnecting that client in their own **Settings > MCP**, or revoking a key.
- Turning an app's **MCP access** off ends MCP on that app, for everyone.

Turning the whole connector off in **Settings > MCP** is a pause, not an end. While it is off no client can call Mantle or renew its sign-in. Turning it on again brings every sign-in back that has not expired.

## Check it worked

In the person's client, the Mantle tool list holds the tools their workspaces allow, plus `app_data_list`, `app_data_schema` and `app_data_query` (and `app_data_write` on a connection that may write). A client that signed in also shows under **Connected clients** in **Settings > MCP**.

## Next

- [Sharing and federation](../04-concepts/06-sharing-and-federation.md)
- [Team and members](../03-using-jackdaw/12-team.md)
