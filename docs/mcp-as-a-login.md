# MCP as a login, and peer tokens bound to a login

Since migration 0227 (plan page `e5b854dd` on the dev brain, 2026-10-03),
`/api/mcp` serves any login, not only the owner. Every request resolves to one
caller (`McpCaller` in `packages/mcp-core/src/login-surface.ts`) from its
bearer (`server/web/lib/mcp-auth.ts`), and gets that caller's tools only.

## Who can connect

| Bearer | Who | Tools |
| --- | --- | --- |
| OAuth token of an admin | the owner | the full owner surface, as before |
| OAuth token of a member or client | that login | its role's responder tools |
| API key `mtlk_...` (migration 0232) | the login that made it | that login's tools, narrowed by the key (docs/guide/07-api/08-api-keys.md) |
| Static token `mtlmcpk_...` (RETIRED, still honoured) | one member or client login | its role's responder tools |
| Peer token `mtlpeer_...` with "Acts as" | the bound login | as that login, with the peer's write switch |

Since 2026-10-07 an admin no longer mints static tokens for a member or
client (`POST /api/mcp-logins/:id/tokens` answers 410): nobody makes a
credential for another login. Each login makes its own API key in
Settings > API access. Tokens minted before keep working until revoked, and
Settings > MCP still lists and revokes them.

A member or client reaches `/api/mcp` only while an admin turned MCP on for
that login (Settings, MCP; table `mcp_login_access`). Their OAuth grants and
static tokens carry the login's session epoch: sign out everywhere, a password
change, a disable or a role change ends them. The box-level remote MCP switch
still gates everything.

## A member's or client's tools

Resolved live from the role's responder agent (`team-responder`,
`client-responder`): its tool groups at the LOGIN's level (an admin-level
group drops out), the private reads only with `teamPrivateReads`, a client cut
to `CLIENT_TURN_TOOL_SLUGS`. Builtins only. Never a tool that spends, waits
for a confirm, is `ownerOnly` or `mcpOnly`. Every call runs through
`dispatchTool` inside `withViewer('team' | 'client')`, so row level security
decides what is read.

Read-only by default. With write on, the login also gets the draft tools of
its own space (`packages/tools/src/builtins-my-space-write.ts`:
`my_note_create`, `my_page_create`, `my_file_upload`, `my_item_submit`) and
its request tool. Never a library write: a draft reaches the brain only when
an admin accepts it.

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

Rebinding a peer to another login starts closed: write off, no risky tools,
unless the same request sets them. Each peer has its own rate budget.

The calling brain uses `peer_tools`, `peer_call` and `peer_file_copy`
(`packages/tools/src/builtins-peer-mcp.ts`) against the peer's `/api/mcp`.
`peer_file_copy` uses the peer's `file_upload` (bound to the owner) or
`my_file_upload` (bound to a member or client).

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
- Non-builtin tools (http, recipe, connector) on the member and client
  surface: their egress is not classified.
- A peer bound to a member or client does not need that login's own MCP
  switch: the admin bound it on purpose. Pending peers verify, as for the
  federation routes.
- The connected-clients list in Settings, MCP shows every login's grants
  without naming the login.
