# Connecting Claude to your Mantle (MCP)

How to wire Claude Desktop or Claude Code onto your Mantle so Claude can
search your brain, read mail, manage tasks/notes/events, walk the entity
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
*writes* through it (a note, a task, a memory) is a real brain write: the
extractor ingests, embeds, and indexes it like any other content. Logging a
`journal` from Claude Desktop literally teaches your in-app assistant who you
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
| Content | `note_*`, `task_*`, `event_*`, `journal_*` (full CRUD), `page_*` / `table_*` (read-only) |
| Knowledge graph | `entity_search`, `entity_facts`, `entity_neighbors`, `entity_mentions`, `graph_path` |
| Telegram | `telegram_pending`, `telegram_send` (allowlisted chats only), `telegram_react`, `telegram_edit`, `telegram_pair` |
| Operator | `pending_list` / `pending_get` / `pending_approve` / `pending_reject` |
| Federation | `peer_list`, `peer_query`, `peer_node_get` |
| Responder | `respond_as_agent` (talk to a responder agent with its real persona + tools) |

Things to try: *"search my Mantle for …"*, *"any unanswered Telegram
messages? draft replies"*, *"what do I know about \<person\>?"*, *"log a
memory: …"*, *"approve the pending tool calls if they look sane"*.

### Talking to a responder agent (`respond_as_agent`)

Everything above is *persona-less* raw data access. `respond_as_agent` is the
exception: it lets Claude send a message **as if it were the user talking to
one of your responder agents**, and runs ONE real turn of that agent's
pipeline — its composed persona (identity + skills), real memory retrieval,
and its real granted tools, which **execute** (delegation via `invoke_agent`
included). It's the "Agent Studio sandbox, but with the real tool loop".

The one thing it does *not* do is persist: **nothing is written to the
agent's conversation history** — no inbound/outbound rows, no usage bump — so
you can probe a responder repeatedly without polluting its memory of talking
to you. Tool **side effects still happen** (a note gets created; a
confirm-gated call lands on `/pending`, returned as `pending_ids`), and the
turn is traced like any other (the reply carries a `trace_id` for `/traces`).

Because nothing is stored, **multi-turn is caller-held**: keep the transcript
yourself and resend it in `history` on each call. Omit `agent_slug` for the
default responder; pass `exclude_tools` to narrow the tool set, `max_iterations`
to cap the loop, or `include_tool_calls: false` to drop the per-call trail from
the reply. Contrast with the in-app Agent Studio sandbox
([`agent-studio.md`](./agent-studio.md)), which composes the same prompt but
makes a plain model call with tools and memory OFF.

## Caveats

- **Cold spawn** takes a few seconds (tsx compiles on first request after
  launch); each call over SSH adds a network round trip. Fine for chat.
- **Writes are real.** There is no sandbox: a `task_create` from Claude
  Desktop is the same row the web app shows, and the extractor will index
  whatever Claude writes.
- **One config per client machine.** stdio means there's nothing to
  centrally provision — each device that should reach the Mantle needs SSH
  access and the config blob once.
