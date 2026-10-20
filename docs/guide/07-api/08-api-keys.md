# API keys

An API key lets a script or an MCP client use your brain as you, with the same rights or fewer. Make one in **Settings > API access**.

A key works on two surfaces only:

- The public HTTP API, `/api/v1` ([The HTTP API](03-http-api.md)).
- The MCP endpoint, `/api/mcp` ([Connect Claude over MCP](01-connect-claude.md)).

Every other route refuses a key, so a key can never change settings, logins or other keys.

## Make a key

1. Open **Settings > API access** and press **Make key**. Members find it in their menu.
2. Name it after what will use it, for example "Nightly backup".
3. Pick the **Access**:
   - **Read only**: the key reads and never writes.
   - **Read and write**: the key also creates and changes items.
4. Pick when it **Expires**: 30 days, 90 days (the default), 1 year or never.
5. Leave **All areas** on, or turn it off and tick only the areas the key needs.
6. Type your password, press **Make key** and copy the key. It is shown once. MantleOS keeps only a hash of it.

A key lasts at most 90 days. A key that never expires or lasts longer, and a key that names risky tools, need a login in the Admin workspace with the keys area.

Each login makes keys for itself. A key acts as its login as the login is now: it reads what that login's workspaces hold, and its access and areas only take away from that. Nobody can make a key that acts as another login.

## Areas

| Area | What it opens |
| --- | --- |
| Search | Search across EVERY kind of item, email and journal included, and the entity tools on MCP. Give it only to a key that may read everything |
| Pages, Notes, Tasks, Tables, Files | That kind of item |
| Calendar | Events |
| Contacts | Contacts |
| Journal | Journal entries |
| Apps | Mini apps (MCP) |
| App data | The data of the mini apps opened to MCP (`app_data_list`, `app_data_schema`, `app_data_query`, `app_data_write`) |

Email reaches a key only through Search. The attachments of synced mail are files, but a key without Search does not see them in Files: they are left out of the lists, one by id answers `404`, and an upload into their folder is refused (on MCP the Files tools refuse them).

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

- Every key gets the same tools as everyone, in its login's workspaces, held to its access and areas. There is no per-login **MCP** or **Write** switch: a key writes when its access is **Read and write**, and then only what its login may change there.
- Tools that manage the brain need a login in the Admin workspace with the matching area. Tools that spend on the owner's provider keys are not offered to a login outside the Admin workspace.
- Tools that send, spend or publish stay blocked until you name them under **Risky MCP tools allowed** when you make the key. Only a login in the Admin workspace with the keys area can name them.
- A key may not change the content of a page or a note others read: one granted to a workspace other than Admin, or with a public link or a contact share. What it embeds would become readable to them, and a key cannot confirm that. Change it in the app. This holds on `/api/v1` too, and for a peer MantleOS acting as a login.
- **API only**: a member's key made before every login had MCP was made for `/api/v1`, so the move to one MCP for every login marked it API only (`api_only`). It keeps working on `/api/v1`, and `/api/mcp` refuses it. Make a new key for MCP. A key made since is never API only.

## What ends a key

- You revoke it in **Settings > API access**.
- It reaches its expiry.
- The login changes its password, or uses **Sign out everywhere**.
- An admin ends the login's sessions, disables it, or changes its role.

A plain sign-out does not end a key. When the login leaves a workspace, its keys lose that workspace's items at once.

Each time a key is made on your login, you get a notice that names the key. If it was not you, revoke the key and change your password.

An admin sees every key on the brain and may revoke any of them. Every other login sees and revokes its own.

## Limits

- 120 requests a minute per key on `/api/v1`, and 300 on `/api/mcp`. All the keys of one login share 600 and 1200. Search has its own 30 a minute per key. Past a limit the answer is `429` with `Retry-After`.
- 20 failed tries a minute for one key prefix from one address, and 100 for any prefix.
- A key cannot confirm a change of who can see an item, and cannot make a page public. Do that in the app.
- 50 live keys per login.

The per-address limits rely on the reverse proxy that ships with MantleOS. Do not serve the brain to the internet without it.

## Next

- [The HTTP API](03-http-api.md)
- [MCP as a login](02-mcp-login.md)
