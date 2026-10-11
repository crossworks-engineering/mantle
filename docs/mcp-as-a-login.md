# MCP as a login, and peer tokens bound to a login

Since migration 0227 (plan page `e5b854dd` on the dev brain, 2026-10-03),
`/api/mcp` serves any login, not only the owner. Every request resolves to one
caller (`McpCaller` in `packages/mcp-core/src/login-surface.ts`) from its
bearer (`server/web/lib/mcp-auth.ts`). Since workspaces W7b (migration 0268)
every login gets the SAME surface, the owner one
(`packages/mcp-core/src/build-server.ts`), in its own workspaces. A login
carries no permission of its own.

## Who can connect

| Bearer                                                | Who                    | Tools                                                                             |
| ----------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| OAuth token of an admin or a member                   | that login             | the one surface, each call in the login's workspaces                              |
| API key `mtlk_...` (migration 0232)                   | the login that made it | the one surface, narrowed by the key (docs/guide/07-api/08-api-keys.md)           |
| Static token `mtlmcpk_...` (RETIRED, revoked by 0268) | one member login       | none: every one is revoked, a call answers 401                                    |
| Peer token `mtlpeer_...` with "Acts as"               | the bound login        | the one surface as that login, narrowed by the peer's write switch and risky list |
| Any bearer of a CLIENT login                          | refused                | none: 403 `no_tools` (no client exists yet, plan 21.9)                            |

The per-login MCP switch (`mcp_login_access`, 0227) is gone: 0268 archives
its rows in `archive_mcp_login_access` and freezes the table (an insert or a
change of its switches is refused). `/api/mcp-logins/*` answers 410. With
the switch gone, no credential it had stopped comes back (W7b fix round 1):
0268 revokes every static token; a login whose MCP was off has its OAuth
grants revoked and the peers bound to it disabled; a login whose MCP was on
with Write off keeps its grants read-only (their scope carries
`mantle:read-only`, which a refresh keeps; `MCP_READ_ONLY_SCOPE` in
`server/web/lib/mcp-oauth.ts`) and its peers' write switch off. A read-only
connection lists only the tools that read. The box-level remote MCP
switch still gates everything, as a pause: while it is off `/api/mcp`, the
consent page, client registration and the token endpoint all answer 404, so
no grant is used or renewed; it revokes nothing (access matrix T10).

## Every call runs in the login's workspaces (W7a, W7b)

No login reads the whole brain. Every call runs in the calling login's
workspaces, as its own screens do (`packages/mcp-core/src/owner-scope.ts`):
an item that lives only in a workspace the login is not in is not found.
Before a tool runs, its gate (`packages/tools/src/admin-gate.ts`) asks the
same scope: an Admin-only tool needs a login that is a user of the Admin
workspace, and a tool that manages the brain (model pools, assistants and
tool groups, connectors, Telegram, mail, peers, sandboxes, secrets) needs
that login's matching area switched on. The same rules decide what is
LISTED (`preparedAllows`): a tool the scope may not call is not on the
list, and the call is refused anyway.

Admin-only: the `ADMIN_ONLY_TOOL_SLUGS` (replay, runs, heartbeats, export,
the owner's approvals queue, the owner's clock, writing into the owner's
assistant conversation, the retrieval eval) and every `ownerOnly` builtin
except `OWNER_ONLY_IN_SCOPE`: the app tools, the row-only tree folders,
`page_move` and a table's history and snapshots, which run in any user's
scope (the database's create, move and delete checks hold). An app a user
outside the Admin workspace makes, duplicates or imports, or whose code or
tools it changes, runs its tools at team rules (`apps.author_level`, the
author ceiling); nothing lifts it but the owner's app update route.

A tool that manages the brain (`run_terminal` too, which needs the settings
area) still runs in the login's workspaces (W7a fix round 1): a file it
imports into a sandbox or copies to a peer, a page it mails, a folder it
mounts are read there, and a file it exports is written there with the
normal checks. Only its own system tables (sandbox rows, peers, mail
accounts, tool groups) are read on the system pool; the tools that touch
nothing else (`AREA_SYSTEM_TOOLS` in admin-gate.ts) run there whole. A write
to an item (an edit, a delete, a move, a link) is checked against the
login's rights on that item first, as the item routes do
(`packages/tools/src/item-write-gate.ts`): an item shared with Read only is
refused.

`MANTLE_ADMIN_READS=system` puts an admin login's calls back on the system
pool, as before W7a. A member's never: on a brain not on workspaces a
member's MCP is refused.

Nothing that spends on the brain owner's provider keys is listed for a
scope that does not hold Admin (W7b fix round 1, a CEO default the owner
may change): the `spends` builtins (a web search, an image, a summary),
`web_crawl`, `process_extraction`, `invoke_agent`, `ask_responder` and
`ask_as_responder` (`spendsOwnerKeys` in
`packages/mcp-core/src/login-surface.ts`). A tool not listed is not
registered, so a direct call is refused too. `search_chunks` stays (its
query embedding is the one `search_nodes` makes). A workspace assistant's
turn keeps its own rules (the member turn ledger).

## Where a create lands (W7b)

A create tool (`MCP_CREATE_TOOL_SLUGS` in
`packages/mcp-core/src/create-home.ts`: notes, pages, files, folders,
tables, apps, formulas, tasks, events, Recall maps and their from-file and
copy variants) takes an
optional `workspace`: the id or name of a workspace the caller moderates
(`workspaces_list` shows them with `moderator`). A workspace it does not
moderate, or is not in, is refused. Without one the item lands by the route
rule (W6b, `mantle_default_home`): the folder's workspace when it is made in
a folder the caller may edit, else the caller's private workspace, and for a
user of the Admin workspace the folder's workspace else Admin. Every create
reply names where the item landed (`landedIn: { id, name }`).

For a user outside Admin every call runs under its private workspace, not
only the listed creates (W7b fix round 1): whatever a tool makes lands by
the rule, never in Admin, and the database refuses a kind that lives only
in Admin. Those creates (`ADMIN_KIND_CREATE_TOOL_SLUGS`: a contact, a
journal entry, a saved place) are not listed for such a user and are
refused before they run. An app such a user makes, copies or imports is
made at team rules with that user named its author.

A deleted app's snapshots are hidden from a scope once its row is gone, so
`app_deleted_list` and `app_undelete` read the trash on the system pool by
the named reason `app-trash`, only for the deleted apps whose home
workspace the caller moderates (an app restored goes back to that home).

## App data (team apps Phase 1, migration 0234)

Every login's MCP gets four tools for the data of mini apps
(`packages/tools/src/builtins-app-data.ts`): `app_data_list`,
`app_data_schema`, `app_data_query` and, with write on, `app_data_write`.
They are in no agent's tool group (the `app-data-mcp` group only seeds
their rows); the MCP surface registers them itself.

- **Reach** (`packages/content/src/mcp-app-data.ts`): an app the login may
  run in the browser (a member: team, client or public level; a client:
  client level; a green published build) whose `apps.mcp_access` is on.
  Off by default; only `PATCH /api/apps/:id { mcpAccess }` (admin) sets it.
  Every other app answers one plain "no such app".
- **Write**: the connection's write (a key's or a peer's switch) and the
  grant's Write switch, never on an informational app.
- **Rows only**: `app_data_write` takes one INSERT, UPDATE, DELETE or
  REPLACE. The SQL child runs it under a data-only engine authorizer (reads,
  the three row writes, functions, a recursive CTE; every CREATE, DROP,
  ALTER, trigger, view, index, transaction and schema-table write refused).
- **Undo**: the first MCP write to an app in an hour takes a
  `pre_mcp_write` snapshot under the app's history lock, on the lock's own
  transaction. If it cannot be taken, the write is refused. Reach and the
  write rule are checked again right before the write. These snapshots
  are pruned on a line of their own (the newest 24 of an app, within
  `APP_SNAPSHOT_MCP_MAX_MB`, default 512), so MCP writes never push out a
  nightly, pre-schema, pre-restore or pre-import snapshot.
- **Trail**: every call lands `app_access_log` rows with `via: 'mcp'`, the
  role, the connection (`key`, `oauth`, `token`, `peer`) and its key id,
  OAuth client or peer. A write keeps its SQL (2 KB), the rows it changed
  and the person's per-app id (`host.me`); a failed statement lands an
  error row with its SQL (500 characters). SQL literals can hold personal
  data the member typed: these rows are for admins only (the app's
  Activity tab, `app_errors`), and the reaper keeps them 90 days (errors
  14). A list is logged as a read: at most one row per app and login a
  minute.
- **Keys**: the area `app_data` holds the four tools. The `apps` area stays
  the authoring tools.

The tools act only for a login whose surface the MCP route stamped
(`surface.mcp`, `LoginMcpChannel`): a chat turn, an app run or the owner's
surface finds no one to act for and is refused.

## Connector tools (team apps Phase 2)

Every login's MCP also gets the tools of the connectors that are resources
of its workspaces (`listLoginConnectorTools`). A tool with the admin's
read-only mark is a read; one without is a write and is offered only with
the connection's write. A tool that needs a confirmation is never offered.
A connector tool is in no key area, so only an all-areas key reaches it.
The call runs in the login's scope and dispatch checks the connector again
(`connectorScopeRefused`): a resource of the scope's workspaces, and for a
write that resource's Write on where the login is a Moderator. Every call
lands an `audit_log` row (`mcp.connector.read` / `mcp.connector.write`)
with the login, the tool, its connector and the connection; a write keeps
its input (2 KB). The remote call runs as the system (`dispatchMcp`), so
the credential stays in the vault.

## Apps

A member builds apps with the same `app_*` tools as an admin, in its own
scope (the `my_app_*` tools were retired in W7b, and their old rows are
disabled by the boot reconcile). Sharing an app is a grant (Grant Access),
never a tool. The app rules are in
[app-authoring-guide.md](app-authoring-guide.md).

## A member's own MCP screen

`GET /api/member/mcp` answers a member's view of Settings > MCP: the box
switch, the connector URL, `access` (always on since W7b), the connectors
of their workspaces, and the clients THEY connected (`listLoginClients`, their live grants).
`DELETE /api/member/mcp/clients/:id` ends only that member's grants on that
client and their open codes, under the login's OAuth lock, every query on
the lock's own transaction (`disconnectLoginClient`). The client
registration and other logins' grants on it stay.

## Peers

A peer gets "Acts as" (owner or a member), a Write switch (default
off) and, for an admin login, a list of risky tools allowed by name
(`mantle_peers.acts_as_login_id`, `acts_as_role`, `write_enabled`,
`allowed_risky_tools`). A role change of the bound login fails closed. A peer
with no "Acts as" is a share-only peer, as before ([federation.md](federation.md)).

The peer gets the one surface as the bound login, filtered by
`ownerPeerAllows`: read-only tools unless write is on, and never a risky tool
unless the owner named it. Risky (`isPeerRiskyTool`): anything that spends,
sends outside (mail, Telegram, the web, other peers), runs a shell or a
container, publishes, queues a run, changes a mini app's code or grants,
hands out privilege, or waits for the owner's confirm in the app (deletes,
restores). A peer never confirms a level change for the owner: its
`confirm` argument is dropped, so a move into a shared folder is refused.

Bound to a member, the peer acts as that member with the peer's own Write
and no risky tool (a member names none). The per-login switches it was
also held to went in W7b.

Rebinding a peer to another login starts closed: write off, no risky tools,
unless the same request sets them. Each peer has its own rate budget.

The calling brain uses `peer_tools`, `peer_call` and `peer_file_copy`
(`packages/tools/src/builtins-peer-mcp.ts`) against the peer's `/api/mcp`.
`peer_file_copy` uses the peer's `file_upload`.

A password change, "sign out everywhere" and an
admin's End sessions also end an ADMIN's OAuth grants and every API key of
the login (endLoginSessions `endKeys`, 2026-10-07). A member or
client MCP request body is held to the plain JSON ceiling (8 MB), so a draft
file over MCP is at most about 6 MB.

## Not done, and why

- Static tokens for admin logins: admins have OAuth, peers and API keys.
- http and recipe tools on MCP: their egress is not classified.
- Pending peers verify, as for the federation routes.
- The admin's connected-clients list in Settings, MCP shows every login's
  grants without naming the login. A member sees only their own (above).
- A member's API key names no risky tool (mint stamps none below admin, a
  W8 change), so it cannot change an app's code; its OAuth grant can.
- Clients: refused until clients exist (plan 21.9).
