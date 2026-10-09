# MCP as a login

Let a team member, a client or another Mantle use your brain from an MCP client, with that login's own rights and nothing more.

The connector URL is the same one the owner uses. Who connects decides which tools they get:

| Who connects       | How they prove it                                         | What they get                                        |
| ------------------ | --------------------------------------------------------- | ---------------------------------------------------- |
| An admin           | Signs in at the connector URL                             | All owner tools                                      |
| A member or client | Signs in at the connector URL, or sends their own API key | Their role's tools, read only unless you allow Write |
| A peer Mantle      | Its peer token, with **Acts as** set                      | The tools of the login it acts as                    |

## Before you start

- The remote connector is on ([Connect Claude over MCP](01-connect-claude.md)).
- The person has a member or client login ([Member and client logins](../05-admin/07-logins.md)).

## Let a member or client connect

1. Open **Settings > MCP**.
2. Under **Team and client access**, find the login and turn on **MCP**.
3. Turn on **Write** only if they should make drafts in their own space, or change rows in the mini apps you open to MCP. An admin still accepts each draft before it reaches the brain.
4. They add the connector URL to Claude and sign in with their own login.

A member finds the connector URL, how to connect, their own access and their connected clients in their own **Settings > MCP**. They can disconnect a client there. They cannot change their access: you set it here.

## Open a mini app's data to MCP

A member's or client's MCP sees no app data until you open an app to it.

1. Open the app and find **MCP access**, beside **Informational**.
2. Turn it on.

Who reaches the app is the same as in the browser: members for a team, client or public app; clients for a client app. They need the app to be published.

| The login's **Write** | The app's **Informational** | What their MCP may do                   |
| --------------------- | --------------------------- | --------------------------------------- |
| Off                   | Any                         | Read the rows                           |
| On                    | Off                         | Read, and insert, update or delete rows |
| On                    | On                          | Read the rows                           |

A public app stays read only for members. MCP never changes an app's tables or columns: the schema belongs to the app's author.

Before the first MCP write to an app in an hour, the brain saves a snapshot of the app (**Before an MCP write** in the app's History). Restore it to undo. These snapshots keep a day of hours (24) on their own, so they never push out the app's other snapshots. Each MCP read and write shows in the app's Activity, and a write keeps its SQL. The SQL can hold what the member typed, personal data included: only admins see the Activity tab.

## Open an outside data source (a connector)

An MCP connector (Settings > MCP connectors) starts at admin level: only admins use it. Set its level in **Settings > Tool groups** to open it:

| Connector level | Who may use its tools                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin           | Admins only                                                                                                                                                   |
| Team            | Members: their own MCP and the apps they run                                                                                                                  |
| Client          | Clients and members: their own MCP and client apps                                                                                                            |
| Public          | Members, plus contacts on a contact-share link of an app and public agents (read-only tools only). Not clients: a client reaches client-level connectors only |

Everyone at that level may use every tool of the connector, so keep a source with secret parts at admin level. The level is the only way in: granting a connector's group to the client agent gives clients nothing. A tool you marked read-only (**I confirm this tool only reads data**) is a read. A tool without the mark changes data: apps of members and clients may call it, and a member's or client's MCP only with their **Write** switch on. Contacts and public agents never get a tool without the mark. Every call is logged with the login.

Removing the mark never closes a tool: it makes it a tool that changes data. To close one, raise the connector's level or switch the tool off. If a connector's tool changes (its description or its inputs), the connector moves to another server, or it signs in another way (a new key, header, OAuth app, scope, or a sign-in as another account), its mark stops counting: members and clients cannot use the tool until you mark it again. A routine OAuth reconnect as the same account keeps the marks. If the server does not say which account signed in, the marks stay and the result page asks you to check them again. On a connector below admin, a tool the server adds later, or one that disappears and comes back, arrives switched off. An agent that turns such a tool on, removes its confirmation, or lowers the whole connector's level waits for your approval in Pending.

## When their MCP client cannot sign in

The member or client makes their own API key in **Settings > API access** and sends it as a header ([API keys](08-api-keys.md)). In Claude Code:

```sh
claude mcp add --transport http mantle https://example.com/api/mcp \
  --header "Authorization: Bearer mtlk_..."
```

The key works only while their **MCP** switch is on, and writes only while both the key and **Write** allow it.

Admins no longer make tokens for other logins. Tokens made before (`mtlmcpk_...`) keep working. They are listed under the login in **Settings > MCP**; press the bin icon to revoke one.

## Let a peer act as a login

1. Open **Settings > Peers** and pick the peer.
2. Set **Acts as** to the owner, a member or a client.
3. Leave **Write** off unless the peer must change things.
   A peer acting as a member or client also needs that login's own **MCP** switch on, and writes only while the login's **Write** is on too.
4. For a peer acting as the owner, list any extra tools under **Risky tools allowed**, for example `web_search`. Tools that spend, send or publish stay blocked until you name them.

Changing **Acts as** turns **Write** off again.

## What ends access

- Turning the login's **MCP** switch off. Its sign-ins, tokens and API keys are revoked, and a peer that acts as it goes back to acting as nobody. Turning **MCP** on again brings none of them back.
- The member disconnecting that client in their own **Settings > MCP**.
- Turning an app's **MCP access** off ends MCP on that app, for everyone.
- A password change, a disable, a role change or "sign out everywhere" for that login. A peer that acts as it goes back to acting as nobody. Its **Write** and risky tools are kept, so setting **Acts as** again restores it.

Turning the whole connector off in **Settings > MCP** is a pause, not an end. While it is off no client can call Mantle or renew its sign-in. Turning it on again brings every sign-in back that has not expired. To end one login's access for good, use its **MCP** switch.

## Check it worked

In the member's client, the Mantle tool list holds their role's tools only, plus `app_data_list`, `app_data_schema` and `app_data_query` (and `app_data_write` with **Write** on). A client that signed in also shows under **Connected clients** in **Settings > MCP**.

## Next

- [Sharing and federation](../04-concepts/06-sharing-and-federation.md)
- [Team and members](../03-using-jackdaw/12-team.md)
