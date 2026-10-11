# MCP as a login, and peer tokens bound to a login

Since migration 0227 (plan page `e5b854dd` on the dev brain, 2026-10-03),
`/api/mcp` serves any login, not only the owner. Every request resolves to one
caller (`McpCaller` in `packages/mcp-core/src/login-surface.ts`) from its
bearer (`server/web/lib/mcp-auth.ts`), and gets that caller's tools only.

## Who can connect

| Bearer                                               | Who                        | Tools                                                                                                                  |
| ---------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| OAuth token of an admin                              | that login                 | the owner surface, each call in the login's workspaces (W7a, below)                                                    |
| OAuth token of a member or client                    | that login                 | its role's responder tools                                                                                             |
| API key `mtlk_...` (migration 0232)                  | the login that made it     | that login's tools, narrowed by the key (docs/guide/07-api/08-api-keys.md)                                             |
| Static token `mtlmcpk_...` (RETIRED, still honoured) | one member or client login | its role's responder tools                                                                                             |
| Peer token `mtlpeer_...` with "Acts as"              | the bound login            | as that login, with the peer's write switch (and, bound to a member or client, the login's MCP and Write switches too) |

Since 2026-10-07 an admin no longer mints static tokens for a member or
client (`POST /api/mcp-logins/:id/tokens` answers 410): nobody makes a
credential for another login. Each login makes its own API key in
Settings > API access. Tokens minted before keep working until revoked, and
Settings > MCP still lists and revokes them.

A member or client reaches `/api/mcp` only while an admin turned MCP on for
that login (Settings, MCP; table `mcp_login_access`). Their OAuth grants and
static tokens carry the login's session epoch: sign out everywhere, a password
change, a disable or a role change ends them. The box-level remote MCP switch
still gates everything, as a pause: while it is off `/api/mcp`, the consent
page, client registration and the token endpoint all answer 404, so no grant
is used or renewed; it revokes nothing, and turning it on again brings back
every grant still inside its refresh life (access matrix T10, a decision).

## An admin's calls run in its workspaces (W7a)

The owner surface (an admin's OAuth grant, its API keys, a peer bound to it,
and stdio, which runs as the brain owner) no longer reads the whole brain.
Every call runs in the calling login's workspaces, as its own screens do
(`packages/mcp-core/src/owner-scope.ts`): an item that lives only in another
user's private workspace is not found. Before a tool runs, its gate
(`packages/tools/src/admin-gate.ts`) asks the same scope: an owner-only or
Admin-only tool needs a login that is a user of the Admin workspace, and a
tool that manages the brain (model pools, assistants and tool groups,
connectors, Telegram, mail, peers, sandboxes, secrets, the team access log,
and `run_terminal`, which needs the settings area) needs that login's
matching area switched on. Such a tool still runs in the login's workspaces
(W7a fix round 1): a file it imports into a sandbox or copies to a peer, a
page it mails, a folder it mounts are read there, and a file it exports is
written there with the normal checks. Only its own system tables (sandbox
rows, peers, mail accounts, tool groups) are read on the system pool; the
tools that touch nothing else (`AREA_SYSTEM_TOOLS` in admin-gate.ts, each
checked handler by handler in fix round 2) run there whole, and a turn one
of them starts (a heartbeat fired) answers the calling login, never the
brain owner. A login works only in the sandboxes it made; only the brain
owner mounts a folder into one. A heartbeat answers the login that set it up
(heartbeats.created_by): Fire now fires in the signed-in login's scope, and
the tick fires a heartbeat another Admin login set up or edited in that
login's scope. A tool template that sends a vault key (`{{secret:...}}`,
`{{oauth:...}}`, an OAuth2 group's token or base URL) is the keys area's:
writing or testing one needs it, and a tool another login wrote resolves its
refs only while that login holds it (`packages/tools/src/secret-ref-gate.ts`,
tools.created_by). So is every other pairing of a vault key with a host
(connectors, integration groups, the API Console proxy, model routes with a
base URL), and a group or connector records who paired them
(tool_groups.configured_by). A login that saves a skill or an agent's prompt
makes the heartbeats that run it its own. A write to an item (an edit, a delete, a move, a link) is
checked against the login's rights on that item first, as the item routes
do (`packages/tools/src/item-write-gate.ts`): an item shared with Read only
is refused. `MANTLE_ADMIN_READS=system` puts the whole surface back on the
system pool, as before.

## A member's or client's tools

Resolved live from the role's responder agent (`team-responder`,
`client-responder`): its tool groups at the LOGIN's level (an admin-level
group drops out), the private reads only with `teamPrivateReads`, a client cut
to `CLIENT_TURN_TOOL_SLUGS`. Builtins only. Never a tool that spends, waits
for a confirm, is `ownerOnly` or `mcpOnly`. Every call runs through
`dispatchTool` inside `withViewer('team' | 'client')`, so row level security
decides what is read.

Read-only by default (plus the app data reads below). With write on, the
login also gets its request tool, `app_data_write` (below) and, for a
member, the changes of its own apps. Never a library write. The draft and
submit tools of a login's own space (`my_note_create`, `my_page_create`,
`my_file_upload`, `my_item_submit`) and `my_app_submit` / `my_app_recall`
went with review in workspaces W5c (plan R7): no login's MCP offers them,
and the boot reconcile disables their old rows (the `my-space-write`
group with them).

## App data (team apps Phase 1, migration 0234)

A member's or client's MCP gets four tools for the data of mini apps
(`packages/tools/src/builtins-app-data.ts`): `app_data_list`,
`app_data_schema`, `app_data_query` and, with write on, `app_data_write`.
They are in no agent's tool group (the `app-data-mcp` group only seeds
their rows); the login surface adds them itself, and replaces the agent's
`app_db_list` / `app_db_query` there, which reach every app at the level
with no per-app switch.

- **Reach** (`packages/content/src/mcp-app-data.ts`): an app the login may
  run in the browser (a member: team, client or public level; a client:
  client level; a green published build) whose `apps.mcp_access` is on.
  Off by default; only `PATCH /api/apps/:id { mcpAccess }` (admin) sets it.
  Every other app answers one plain "no such app".
- **Write**: the login's Write switch (on the key or peer too) and the
  browser's rule: a member writes a team or client app, a client a client
  app, and neither an informational one. A public app reads only.
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

A member's or client's MCP also gets the tools of the MCP connectors whose
level its login's level reads (`listLoginConnectorTools`): a member a
connector at team, client or public level, a client one at client level.
The connector's level is the grant, outside the responder's groups and the
client cut. A tool with the admin's read-only mark is a read; one without
is a write and is offered only with the login's Write switch on (on the key
or peer too). A tool that needs a confirmation is never offered. A
connector tool is in no key area, so only an all-areas key reaches it.
On a brain the workspaces migration made live, the login's workspaces
decide too (`loginConnectorRule`): the connector must be a resource of one
of them, and a write tool needs that resource's Write on in a workspace
where the login is a Moderator. A login in no workspace gets no connector
tool. The listing, the call and the login's app runs use the same rule, so
the MCP never lists a tool the call refuses. Every call lands an `audit_log` row (`mcp.connector.read` /
`mcp.connector.write`) with the login, the tool, its connector and the
connection; a write keeps its input (2 KB). The remote call runs as the
system (`dispatchMcp`), so the credential stays in the vault. Members see
the connectors open to them in their own Settings > MCP
(`GET /api/member/mcp` `connectors`).

## A member's own apps (team apps Phase 3)

Sharing an app with the team is the member's own click in the app (Apps >
Your apps), never an MCP tool: a key, a peer or a model must not open an app
to the whole team (access matrix N1). `my_app_unshare` makes one private. An
admin sees the shared ones in Apps, above the brain's own
apps, with their activity, and may unshare or delete them; an app runs only while its
author is an active member. The member deletes their own app to a trash in
their space (`my_app_delete`, access matrix N6), where nothing is removed, and
brings it back with `my_app_undelete`. Every my_app change over an OAuth,
token or peer connection writes an audit row (`mcp.my_app_*`, with the app id
and, for a snapshot restore or delete, the snapshot id); a key's call has its
own.

A member's MCP also lists the `my_app_*` tools
(`packages/tools/src/builtins-my-apps.ts`): the reads always, the changes
with the Write switch. A client never gets them. They act only on the
member's own apps, found by the author's row in the member's own space
(`authorSpaceApp`), and run as the system with the space as owner, so they
never reach a brain app. Key area: `apps` (prefix `my_app_`). Submit and
recall are gone since W5c. The app rules (private, shared, the author
ceiling) are in
[app-authoring-guide.md](app-authoring-guide.md), "Members build apps".

## A member's own MCP screen

`GET /api/member/mcp` answers a member's view of Settings > MCP: the box
switch, the connector URL, their own MCP and Write switches (read only),
and the clients THEY connected (`listLoginClients`, their live grants).
`DELETE /api/member/mcp/clients/:id` ends only that member's grants on that
client and their open codes, under the login's OAuth lock, every query on
the lock's own transaction (`disconnectLoginClient`). The client
registration and other logins' grants on it stay.

## Peers

A peer gets "Acts as" (owner, a member, or a client), a Write switch (default
off) and, for the owner, a list of risky tools allowed by name
(`mantle_peers.acts_as_login_id`, `acts_as_role`, `write_enabled`,
`allowed_risky_tools`). A role change of the bound login fails closed. A peer
with no "Acts as" is a share-only peer, as before ([federation.md](federation.md)).

Bound to the owner, the peer gets the owner surface filtered by
`ownerPeerAllows`: read-only tools unless write is on, and never a risky tool
unless the owner named it. Risky (`isPeerRiskyTool`): anything that spends,
sends outside (mail, Telegram, the web, other peers), runs a shell or a
container, publishes, queues a run, changes a mini app's code or grants,
hands out privilege, or waits for the owner's confirm in the app (deletes,
restores). A peer never confirms a level change for the owner: its
`confirm` argument is dropped, so a move into a shared folder is refused.

Bound to a member or client, the peer acts under that login's switches
too (team apps M1 audit, 2026-10-08): with the login's MCP switch off the
peer is refused, and it writes only while both the peer's Write and the
login's Write are on. Before, a bound peer ignored the login's switches.

Rebinding a peer to another login starts closed: write off, no risky tools,
unless the same request sets them. Each peer has its own rate budget.

The calling brain uses `peer_tools`, `peer_call` and `peer_file_copy`
(`packages/tools/src/builtins-peer-mcp.ts`) against the peer's `/api/mcp`.
`peer_file_copy` uses the peer's `file_upload` (bound to the owner); a
peer bound to a member or client takes no files (`my_file_upload` went in
W5c).

Turning a login's MCP off revokes its grants and static tokens. A client's
sign-out ends all its sessions by design, so it also ends that client's MCP
grants and static tokens. A password change, "sign out everywhere" and an
admin's End sessions also end an ADMIN's OAuth grants and every API key of
the login (endLoginSessions `endKeys`, 2026-10-07). A member or
client MCP request body is held to the plain JSON ceiling (8 MB), so a draft
file over MCP is at most about 6 MB.

## Not done, and why

- Static tokens for admin logins: admins have OAuth, peers and API keys.
- Folder and event create for members and clients: members have no event
  rights, and own-space folders are a tree feature with its own routes.
- http and recipe tools on the member and client surface: their egress is
  not classified. (Connector tools are on it since Phase 2, below.)
- Pending peers verify, as for the federation routes.
- The admin's connected-clients list in Settings, MCP shows every login's
  grants without naming the login. A member sees only their own (above).
- A client login has no MCP screen yet; it reaches app data over MCP the
  same way.
