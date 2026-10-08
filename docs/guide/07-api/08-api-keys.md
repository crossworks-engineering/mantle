# API keys

An API key lets a script or an MCP client use your brain as you, with the same rights or fewer. Make one in **Settings > API access**.

A key works on two surfaces only:

- The public HTTP API, `/api/v1` ([The HTTP API](03-http-api.md)).
- The MCP endpoint, `/api/mcp` ([Connect Claude over MCP](01-connect-claude.md)).

Every other route refuses a key, so a key can never change settings, logins or other keys.

## Make a key

1. Open **Settings > API access** and press **Make key**. Members find it in their menu, clients under **API keys**.
2. Name it after what will use it, for example "Nightly backup".
3. Pick the **Access**:
   - **Read only**: the key reads and never writes.
   - **Read and write**: the key also creates and changes items.
4. Pick when it **Expires**: 30 days, 90 days (the default), 1 year or never.
5. Leave **All areas** on, or turn it off and tick only the areas the key needs.
6. Type your password (admins and members), press **Make key** and copy the key. It is shown once. Mantle keeps only a hash of it.

A member's key lasts at most 90 days and a client's at most 30. Only an admin's key may never expire.

Each login makes keys for itself. An admin's key acts as that admin, a member's as that member, a client's as that client. Nobody can make a key that acts as another login.

## Areas

| Area | What it opens |
| --- | --- |
| Search | Search across EVERY kind of item, email and journal included, and the entity tools on MCP. Give it only to a key that may read everything |
| Pages, Notes, Tasks, Tables, Files | That kind of item |
| Calendar | Events |
| Contacts | Contacts |
| Journal | Journal entries |
| Apps | Mini apps (MCP) |
| App data | The data of the mini apps an admin opened to MCP (`app_data_list`, `app_data_schema`, `app_data_query`, `app_data_write`). A member's or client's key only |

A route or tool that belongs to no area, such as reading any item by id, the Recall tools or a tool that turns one kind into another (`page_from_journal`), needs **All areas**.

## Use a key

Send it as a bearer token:

```sh
curl -s https://example.com/api/v1/whoami \
  -H "Authorization: Bearer mtlk_..."
```

`whoami` answers with the login the key acts as and what the key may do. In Claude Code:

```sh
claude mcp add --transport http mantle https://example.com/api/mcp \
  --header "Authorization: Bearer mtlk_..."
```

## Keys on MCP

- An admin's key gets the owner tools, held to its access and areas. Tools that send, spend or publish stay blocked until you name them under **Risky MCP tools allowed** when you make the key.
- A member's or client's key gets that login's own tools. It also needs **MCP** turned on for the login in **Settings > MCP**, and it writes only while both the key and the login's **Write** switch allow it.

## What ends a key

- You revoke it in **Settings > API access**.
- It reaches its expiry.
- The login changes its password, or uses **Sign out everywhere**.
- An admin ends the login's sessions, disables it, or changes its role.

A plain sign-out does not end an admin's or member's key. A client's key ends when the client signs out, because a client has no password to type when making one.

Each time a key is made on your login, you get a notice that names the key. If it was not you, revoke the key and change your password.

An admin sees every key on the brain and may revoke any of them. Members and clients see and revoke their own.

## Limits

- 120 requests a minute per key on `/api/v1`, and 300 on `/api/mcp`. All the keys of one login share 600 and 1200. Search has its own 30 a minute per key. Past a limit the answer is `429` with `Retry-After`.
- 20 failed tries a minute for one key prefix from one address, and 100 for any prefix.
- A key cannot confirm a change of who can see an item, and cannot make a page public. Do that in the app.
- 50 live keys per login.

The per-address limits rely on the reverse proxy that ships with Mantle. Do not serve the brain to the internet without it.

## Next

- [The HTTP API](03-http-api.md)
- [MCP as a login](02-mcp-login.md)
