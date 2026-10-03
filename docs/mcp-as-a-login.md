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
| Static token `mtlmcpk_...` | one member or client login | its role's responder tools |
| Peer token `mtlpeer_...` with "Acts as" | the bound login | as that login, with the peer's write switch |

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
(anything that spends, sends outside, runs a shell or a container, publishes,
or hands out privilege: `PEER_RISKY_TOOL_SLUGS`) unless the owner named it.

The calling brain uses `peer_tools`, `peer_call` and `peer_file_copy`
(`packages/tools/src/builtins-peer-mcp.ts`) against the peer's `/api/mcp`.
`peer_file_copy` uses the peer's `file_upload` (bound to the owner) or
`my_file_upload` (bound to a member or client).

## Not done, and why

- Static tokens for admin logins: admins have OAuth and peers.
- Folder and event create for members and clients: members have no event
  rights, and own-space folders are a tree feature with its own routes.
- Non-builtin tools (http, recipe, connector) on the member and client
  surface: their egress is not classified.
