# MCP as a login

Let a team member, a client or another Mantle use your brain from an MCP client, with that login's own rights and nothing more.

The connector URL is the same one the owner uses. Who connects decides which tools they get:

| Who connects | How they prove it | What they get |
| --- | --- | --- |
| An admin | Signs in at the connector URL | All owner tools |
| A member or client | Signs in at the connector URL, or sends their own API key | Their role's tools, read only unless you allow Write |
| A peer Mantle | Its peer token, with **Acts as** set | The tools of the login it acts as |

## Before you start

- The remote connector is on ([Connect Claude over MCP](01-connect-claude.md)).
- The person has a member or client login ([Member and client logins](../05-admin/07-logins.md)).

## Let a member or client connect

1. Open **Settings > MCP**.
2. Under **Team and client access**, find the login and turn on **MCP**.
3. Turn on **Write** only if they should make drafts in their own space. An admin still accepts each draft before it reaches the brain.
4. They add the connector URL to Claude and sign in with their own login.

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
4. For a peer acting as the owner, list any extra tools under **Risky tools allowed**, for example `web_search`. Tools that spend, send or publish stay blocked until you name them.

Changing **Acts as** turns **Write** off again.

## What ends access

- Turning the login's **MCP** switch off. Its sign-ins and tokens stop working.
- A password change, a disable, a role change or "sign out everywhere" for that login.
- Turning the whole connector off in **Settings > MCP**.

## Check it worked

In the member's client, the Mantle tool list holds their role's tools only. A client that signed in also shows under **Connected clients** in **Settings > MCP**.

## Next

- [Sharing and federation](../04-concepts/06-sharing-and-federation.md)
- [Team and members](../03-using-jackdaw/12-team.md)
