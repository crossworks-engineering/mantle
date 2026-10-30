# MCP as a login, and peer tokens bound to a login

Since migration 0227 (plan page `e5b854dd` on the dev brain, 2026-10-03),
`/api/mcp` serves any login, not only the owner. Every request resolves to one
caller (`McpCaller` in `packages/mcp-core/src/login-surface.ts`) from its
bearer (`server/web/lib/mcp-auth.ts`). Since workspaces W7b (migration 0268)
every login gets the SAME surface, the owner one
(`packages/mcp-core/src/build-server.ts`), in its own workspaces. A login
carries no permission of its own. The access model as a whole:
[workspaces.md](./workspaces.md).

## Who can connect

| Bearer                                                | Who                    | Tools                                                                             |
| ----------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| OAuth token of an admin or a member                   | that login             | the one surface, each call in the login's workspaces                              |
| API key `mtlk_...` (migration 0232)                   | the login that made it | the one surface, narrowed by the key (docs/guide/07-api/08-api-keys.md)           |
| Static token `mtlmcpk_...` (RETIRED, revoked by 0268) | one member login       | none: every one is revoked, a call answers 401                                    |
| Peer token `mtlpeer_...` with "Acts as"               | the bound login        | the one surface as that login, narrowed by the peer's write switch and risky list |
| Any bearer of a former client login                   | refused                | none: the login is disabled and its credentials revoked (W8a, migration 0272)     |

The per-login MCP switch (`mcp_login_access`, 0227) is gone: 0268 archives
its rows in `archive_mcp_login_access` and freezes the table (an insert or a
change of its switches is refused). `/api/mcp-logins/*` answered 410 until arch A7 (no route since). With
the switch gone, no credential it had stopped comes back (W7b fix round 1):
0268 revokes every static token; a member or client login whose MCP was off
has its OAuth grants revoked and the peers bound to it disabled; one whose
MCP was on with Write off keeps its grants read-only (their scope carries
`mantle:read-only`, which a refresh keeps; `MCP_READ_ONLY_SCOPE` in
`server/web/lib/mcp-oauth.ts`) and its peers' write switch off. Its API
keys (`mtlk_`) go the same way (W7b fix round 2): revoked where MCP was
off, read-only where Write was off; an admin login's keys never went
through the switch, so a leftover switch row of an admin changes none of
them (W7b fix round 3). A member or client login with no
switch row never reached MCP: its keys were made for `/api/v1`, so 0268
marks them `api_only` (they keep working there; `/api/mcp` refuses them)
and disables the peers bound to it. Only credentials made before the
archive are touched (for a login with no switch row, before the cutoff
`archive_mcp_cutoff` records on the first run); a key made since has no
`api_only`. A read-only
connection lists only the tools that read. The box-level remote MCP
switch still gates everything, as a pause: while it is off `/api/mcp`, the
consent page, client registration and the token endpoint all answer 404, so
no grant is used or renewed; it revokes nothing (access matrix T10).

## Every call runs in the login's workspaces (W7a, W7b)

No login reads the whole brain. Every call runs in the calling login's
workspaces, as its own screens do (`packages/mcp-core/src/mcp-scope.ts`):
an item that lives only in a workspace the login is not in is not found.
Every tool is listed and called through the one gate
(`packages/mcp-core/src/gated-tools.ts`, the gate's caller in
`packages/mcp-core/src/gate-policy.ts`), which asks the same scope: an
Admin-only tool needs a login that is a user of the Admin workspace, and a
tool that manages the brain (model pools, assistants and tool groups,
connectors, Telegram, mail, peers, sandboxes, secrets) needs that login's
matching area switched on. Listing equals calling: a tool the scope may
not call is not on the list, and the call is refused anyway. A login that
is a user of no workspace lists no tools at all, and the server
instructions say why (A5 step 4).

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
nothing else (`AREA_SYSTEM_TOOLS` in admin-gate.ts, each checked handler by
handler in fix round 2) run there whole, and a turn one of them starts (a
heartbeat fired) answers the calling login, never the brain owner. A login
works only in the sandboxes it made; only the brain owner mounts a folder
into one. A heartbeat answers the login that set it up
(heartbeats.created_by): only that login fires it now (Fire now and
`heartbeat_fire`; anyone else is refused), in its own scope, and the tick
fires a heartbeat another Admin login set up or edited in that
login's scope. A tool template that sends a vault key (`{{secret:...}}`,
`{{oauth:...}}`, an OAuth2 group's token or base URL) is the keys area's:
writing or testing one needs it, and a tool another login wrote resolves its
refs only while that login holds it (`packages/tools/src/secret-ref-gate.ts`,
tools.created_by). So is every other pairing of a vault key with a host
(connectors, integration groups, the API Console proxy, a mail account's
stored password against a new host, model routes with a base URL, whose key
is the key id or else the provider's), and a group, connector or model route
records who paired them (configured_by) and answers to that login at run
time. A login that saves a skill or an agent's prompt makes the heartbeats
that run it its own. A write
to an item (an edit, a delete, a move, a link) is checked against the
login's rights on that item first, as the item routes do
(`packages/tools/src/item-write-gate.ts`): an item shared with Read only is
refused.

Every login's calls run in its own workspaces: there is no system-pool path
for an admin login since arch A7 (the `MANTLE_ADMIN_READS=system` rollback
switch and the rule of a brain not on workspaces are gone; such a brain
does not start, [workspaces.md](./workspaces.md), "Operator notes").

The Telegram inbox tools (`telegram_pending`, `telegram_react`,
`telegram_edit`, `telegram_mark_processed`) answer the anchor only, and
`telegram_send` refuses any other login on a direct owner path (W7
integration fix 2); the anchor's own turns keep sending.

Nothing that spends on the brain owner's provider keys is listed for a
scope that does not hold Admin (W7b fix round 1, a CEO default the owner
may change): the `spends` builtins (a web search, an image, a summary),
`web_crawl`, `route_map` (the owner's Mapbox key, W7 integration fix 2),
`process_extraction`, `invoke_agent`, `ask_responder` and
`ask_as_responder` (`spendsOwnerKeys` in
`packages/mcp-core/src/login-surface.ts`). A tool not listed is not
registered, so a direct call is refused too. `search_chunks` stays (its
query embedding is the one `search_nodes` makes), but on such a connection
it never runs its paid step, the `passage_scoring` decider (W7b fix round
2): the connection carries `ownerKeysOff` (`LoginMcpChannel`) and the
search returns the plain ranking. A workspace assistant's turn keeps its
own rules (the member turn ledger).

## Where a create lands (W7b)

A create tool (`MCP_CREATE_TOOL_SLUGS` in
`packages/mcp-core/src/create-home.ts`: notes, pages, files, folders,
tables, apps, formulas, tasks, events, Recall maps and their from-file and
copy variants) takes an
optional `workspace`: the id or name of a workspace the caller moderates
(`workspaces_list` shows them with `moderator`). A workspace it does not
moderate, or is not in, is refused (the one create-home intent,
`createHomeIntent` in `packages/db/src/create-home.ts`, the same function
the web routes and assistant turns ask). Without one the item lands by the route
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
made at team rules with that user named its author. A user outside Admin
who is in no workspace has no private workspace: each of its creates is
refused with a reply that says so (`NO_WORKSPACE_CREATE_ERROR`), before the
database would refuse the row.

A deleted app's snapshots are hidden from a scope once its row is gone, so
`app_deleted_list` and `app_undelete` read the trash on the system pool by
the named reason `app-trash`, only for the deleted apps whose home
workspace the caller moderates (an app restored goes back to that home). In
the anchor's own chat (its turn scope holds only Admin) the homes are those
of the anchor's full login scope (W7 integration fix 2).

## App data (team apps Phase 1, migration 0234)

Every login's MCP gets four tools for the data of mini apps
(`packages/tools/src/builtins-app-data.ts`): `app_data_list`,
`app_data_schema`, `app_data_query` and, with write on, `app_data_write`.
They are in no agent's tool group (the `app-data-mcp` group only seeds
their rows); the MCP surface registers them itself.

- **Reach** (`packages/content/src/mcp-app-data.ts`): an app the login may
  run in the browser (granted to one of its workspaces, with a green
  published build) whose `apps.mcp_access` is on. Off by default; only
  `PATCH /api/apps/:id { mcpAccess }` sets it.
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
The call runs in the login's scope and under its create home, registered
and called through the one gate as every builtin is
(`packages/mcp-core/src/gated-tools.ts`), and dispatch checks the connector again
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

A peer gets "Acts as" (a login), a Write switch (default off) and a list
of risky tools allowed by name (`mantle_peers.acts_as_login_id`,
`write_enabled`, `allowed_risky_tools`). It acts as the bound login as
that login is now (W8a): the role it was bound under was archived in
`archive_peer_roles` and its column dropped by migration 0272, after a peer
the old role check refused was ended. A peer with no "Acts as" is a
share-only peer, as before ([federation.md](federation.md)).

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
admin's End sessions also end the login's OAuth grants and every API key of
the login (endLoginSessions `endKeys`, 2026-10-07). A member's MCP request
body is held to the plain JSON ceiling (8 MB), so a draft file over MCP is
at most about 6 MB.

## The call log (Journal v3 J8)

Every MCP tool call leaves one row in `mcp_calls` (migration 0345): over
HTTP and over stdio, for every login kind (an OAuth connector, an API key,
a peer, the stdio server). It is learning data for a later step that
learns from how a login works over MCP. It is not the security trail: an
API key's write keeps its own `audit_log` row as before.

A row holds the login and how it connected (`via`), the workspace the call
named or a create landed in, a work session id, the tool, its arguments,
whether it worked, the error text, the duration, the item ids the
arguments and the top-level reply name (at most 50) and the reply's size.
The reply itself is never kept. Before a row is written its arguments lose
every value under a key that reads as a secret (whole words: password,
secret, token, API key, a bare `key`, authorization, cookie, credential,
private key; a name ending in `_ref` or `_url` is kept, it names a secret
and holds none), every field the builtin marks sensitive (the same list
the tool loop redacts before `trace_steps`), the value of a header pair
named as a secret (`{name: 'Authorization', value}`), and the token part
of a string that carries one (`Bearer …`, `sk-`, `ghp_`, `xoxb-`, `AKIA`,
`mtlk_`, a URL's `key`, `token` or `sig` parameter). A `secret_*` tool,
and a connector's `mcp_<conn>_…secret…` tool, keeps only the names of its
arguments. The arguments are capped at about 4 KB and the error, its
tokens redacted the same way, at about 1 KB.

A call joins the work session of the same login's last call when that
was within 30 minutes; otherwise it starts a new one. The insert reads it
in the same statement, and one login's rows are written one after the
other in a process, so a burst of parallel calls lands in one session.

One place writes it: the one registration every MCP tool goes through
(`packages/mcp-core/src/gated-tools.ts`, shaped by
`packages/mcp-core/src/call-log.ts`, written by
`packages/db/src/mcp-call-log.ts`). The row is shaped after the reply went
out and written fire and forget, as the system (`system:audit:mcp-call`):
it never fails, slows or changes the call. At most 32 rows are in flight;
past that a row is dropped and counted, and a failed insert is counted and
said on the console at most once every ten minutes, never retried. A call
the MCP SDK refuses before the handler runs (input that fails the tool's
schema, an unknown tool name) is not logged yet.

Who reads it is the database's rule: a login reads its own rows only, and
so does an Admin user (being an Admin user is management, not reading,
[workspaces.md](./workspaces.md)), as with its chat
(`GET /api/mcp-calls`, in the caller's scope; filters `session`, `tool`,
`before`, `limit`). A reader across logins, such as the later learner,
reads on the system pool. No login's scope may write
the table. The nightly `mcp-calls-reap` sweep removes rows older than 90
days (by hand `pnpm -C server/web mcp-calls:reap`, dry run unless
`--apply`). No model runs on any of it.

## ChatGPT and the `resource` value (corporate plan phase 3)

ChatGPT connects as any MCP client does: RFC 9728 discovery from the 401,
RFC 7591 registration, PKCE S256, then the token endpoint
([09-connect-chatgpt.md](./guide/07-api/09-connect-chatgpt.md)). It also
sends the RFC 8707 `resource` value (the protected resource metadata's
`resource`, `${MANTLE_PUBLIC_URL}/api/mcp`) on the authorization request
and on both token grants, as the MCP spec asks every client to.

An access token here is an opaque handle to a row in this box's database,
honoured only at this box's `/api/mcp`, so it is bound to that one
resource whatever the client sent: there is no `aud` claim to copy the
value into. `server/web/lib/mcp-resource.ts` checks each value against
the public URL and the origin the request came in on (an old host name the
box still serves), the MCP endpoint or the bare origin, and logs one line
(`[mcp-oauth] resource mismatch at ...`) for a value that names another
server. It never refuses: a Claude connector that sends no value, and an
old host name, work as before (plan section 2.1). The whole flow, for a
ChatGPT-shaped client, a Claude-shaped one and an old host, is
`server/web/lib/mcp-connector-flow.db.test.ts`.

ChatGPT registers ONCE per workspace app and every person in that ChatGPT
workspace signs in on that one client id. A member's own Disconnect
(`disconnectLoginClient`) revokes only their grants; the admin's
Disconnect in Settings, MCP (`disconnectClient`) deletes the client row,
which ends every person's grants and leaves ChatGPT with `invalid_client`
until a ChatGPT admin adds the app again.

## Not done, and why

- Static tokens for admin logins: admins have OAuth, peers and API keys.
- Client ID Metadata Documents (OpenAI's preferred registration, the MCP
  spec's SHOULD): dynamic registration still works for ChatGPT, so it is
  later. ChatGPT prefers it when a server offers it, so offering
  `client_id_metadata_document_supported` changes how the ChatGPT apps
  already connected sign in: it needs its own plan.
- RFC 9207 `iss` on the authorization response: optional for ChatGPT.
  Advertising it lets ChatGPT use its stable redirect URI, which the
  existing ChatGPT registrations may not hold, so turning it on is a
  change for connected clients, made only with a plan for them.
- `offline_access` in `scopes_supported`: refresh tokens are issued on
  every grant whatever the scope, so it is not advertised.
- http and recipe tools on MCP: their egress is not classified.
- Pending peers verify, as for the federation routes.
- The admin's connected-clients list in Settings, MCP shows every login's
  grants without naming the login. A member sees only their own (above).
- A key of a login that is not in the Admin workspace with the keys area
  names no risky tool (W8a), so it cannot change an app's code; its OAuth
  grant can.
- Clients: removed (W8a, [client-logins.md](./client-logins.md)). A client
  may come back later as an ordinary workspace, set up by hand.
