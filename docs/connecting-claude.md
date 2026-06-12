# Connecting Claude to your Mantle (MCP)

How to wire Claude Desktop or Claude Code onto your Mantle so Claude can
search your brain, read mail, manage todos/notes/events, walk the entity
graph, and answer Telegram — using the bundled MCP server. One-time setup
per client machine; after that the tools are simply present every launch.

**What this is (and isn't).** [`apps/mcp`](../apps/mcp/src/server.ts) is a
**tool surface**, not a chat channel: ~70 tools of raw, persona-less access to
your data — including the full Toolsmith set (`api_tool_*`, `web_fetch`,
groups + grants), so a Claude Code session can read a service's API docs and
author/test/deploy new agent tools on your own subscription instead of
Mantle's metered key. See [`toolsmith.md`](./toolsmith.md). A conversation you have in Claude Desktop does *not* enter the
unified conversation stream ([`conversation.md`](./conversation.md)) — your
in-app assistant won't "remember" the chat itself. But everything Claude
*writes* through it (a note, a todo, a life log) is a real brain write: the
extractor ingests, embeds, and indexes it like any other content. Logging a
`lifelog` from Claude Desktop literally teaches your in-app assistant who you
are.

## The security model — read this first

The server is **stdio-only, on purpose**. There is no port, no token, no
login: *whoever can spawn the process gets the owner's full data access.*
That makes the setup below trivially simple and safe on machines you control
— and means you must **never** wrap it in a network listener "to make it
easier". The remote shape below uses SSH precisely so your existing SSH key
remains the entire auth layer. (An HTTP transport with a real auth layer is
the documented future path for phones / one-click connectors; it is
intentionally not wired today.)

Owner resolution: with a single `auth.users` row (the normal self-hosted
state) the server scopes to it automatically. Multiple rows → set
`ALLOWED_USER_ID` in the env the server reads; it validates the UUID exists
at boot.

## Pick your shape

The command Claude spawns depends on where your Mantle runs. Three shapes:

### A. Dev checkout on the same machine

The dev stack (`pnpm start`) already launches the MCP server for Claude
Code in the repo; for Claude Desktop point it at the same entry:

```json
{
  "mcpServers": {
    "mantle": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/mantle/apps/mcp", "start"]
    }
  }
}
```

Requires the local stack up (Postgres, and the local embedder for semantic
search — a failed embed degrades `search` to keyword-only, not an error).

### B. Docker stack on the same machine

The production image keeps the full workspace + `tsx` by design, so the
server runs inside the existing `mantle_web` container — no extra install:

```json
{
  "mcpServers": {
    "mantle": {
      "command": "docker",
      "args": ["exec", "-i", "mantle_web", "pnpm", "-C", "apps/mcp", "start"]
    }
  }
}
```

The container's own env supplies the DB / MinIO / embedder routes.

### C. Remote server over SSH (the production shape)

Same as B, reached through SSH. Needs: key-based SSH login to the box, and
your user in the `docker` group there. Put an alias in `~/.ssh/config` so
the config stays readable:

```
Host my-mantle
  HostName mantle.example.com
  User cwe
  IdentityFile ~/.ssh/id_ed25519
```

```json
{
  "mcpServers": {
    "mantle": {
      "command": "ssh",
      "args": ["my-mantle", "docker", "exec", "-i", "mantle_web",
               "pnpm", "-C", "apps/mcp", "start"]
    }
  }
}
```

JSON-RPC rides the SSH pipe; nothing new is exposed on the network.

## Where the config lives

- **Claude Desktop (macOS):** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Claude Desktop (Windows):** `%APPDATA%\Claude\claude_desktop_config.json`

Merge the `mcpServers` key into the existing file (don't clobber other
keys), then fully restart Claude Desktop. The server appears as `mantle`
in the tools menu.

- **Claude Code:** one command, no file editing:

```bash
claude mcp add mantle -- ssh my-mantle docker exec -i mantle_web pnpm -C apps/mcp start
# add --scope user to make it available in every project
```

## Verify without Claude

One line proves the whole path (SSH → container → server → DB) — expect a
`serverInfo: "mantle"` JSON reply within a few seconds:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  | ssh my-mantle 'docker exec -i mantle_web pnpm -C apps/mcp start' | head -1
```

If instead you see `No account yet` — sign up in the web app first. If
`ALLOWED_USER_ID ... does not match` — the env points at a deleted user.

## What you get

| Area | Tools |
|---|---|
| Search | `search` (hybrid semantic+keyword), `search_chunks` (passage-level), `tree_list` |
| Email | `email_list`, `email_get` |
| Files | `folder_*`, `file_*` (list/read/upload/delete) |
| Content | `note_*`, `todo_*`, `event_*`, `lifelog_*` (full CRUD), `page_*` / `table_*` (read-only) |
| Knowledge graph | `entity_search`, `entity_facts`, `entity_neighbors`, `entity_mentions`, `graph_path` |
| Telegram | `telegram_pending`, `telegram_send` (allowlisted chats only), `telegram_react`, `telegram_edit`, `telegram_pair` |
| Operator | `pending_list` / `pending_get` / `pending_approve` / `pending_reject` |
| Federation | `peer_list`, `peer_query`, `peer_node_get` |

Things to try: *"search my Mantle for …"*, *"any unanswered Telegram
messages? draft replies"*, *"what do I know about \<person\>?"*, *"log a
lifelog: …"*, *"approve the pending tool calls if they look sane"*.

## Caveats

- **Cold spawn** takes a few seconds (tsx compiles on first request after
  launch); each call over SSH adds a network round trip. Fine for chat.
- **Writes are real.** There is no sandbox: a `todo_create` from Claude
  Desktop is the same row the web app shows, and the extractor will index
  whatever Claude writes.
- **One config per client machine.** stdio means there's nothing to
  centrally provision — each device that should reach the Mantle needs SSH
  access and the config blob once.
