# Connecting Claude to your Mantle (MCP)

How to wire Claude Desktop or Claude Code onto your Mantle so Claude can
search your brain, read mail, manage tasks/notes/events, walk the entity
graph, and answer Telegram, using the bundled MCP server. One-time setup
per client machine; after that the tools are simply present every launch.

**What this is (and isn't).** [`apps/mcp`](../apps/mcp/src/server.ts) is a
**tool surface**, not a chat channel: ~70 tools of raw, persona-less access to
your data, including the full Toolsmith set (`api_tool_*`, `web_fetch`,
groups + grants), so a Claude Code session can read a service's API docs and
author/test/deploy new agent tools on your own subscription instead of
Mantle's metered key. See [`toolsmith.md`](./toolsmith.md). A conversation you have in Claude Desktop does *not* enter the
unified conversation stream ([`conversation.md`](./conversation.md)), your
in-app assistant won't "remember" the chat itself. But everything Claude
*writes* through it (a note, a task, a memory) is a real brain write: the
extractor ingests, embeds, and indexes it like any other content. Logging a
`journal` from Claude Desktop literally teaches your in-app assistant who you
are.

## The security model: read this first

The server is **stdio-only, on purpose**. There is no port, no token, no
login: *whoever can spawn the process gets the owner's full data access.*
That makes the setup below trivially simple and safe on machines you control
, and means you must **never** wrap it in a network listener "to make it
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
search, a failed embed degrades `search` to keyword-only, not an error).

### B. Docker stack on the same machine

The production image keeps the full workspace + `tsx` by design, so the
server runs inside the existing `mantle_web` container, no extra install:

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

One line proves the whole path (SSH → container → server → DB), expect a
`serverInfo: "mantle"` JSON reply within a few seconds:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  | ssh my-mantle 'docker exec -i mantle_web pnpm -C apps/mcp start' | head -1
```

If instead you see `No account yet`, sign up in the web app first. If
`ALLOWED_USER_ID ... does not match`, the env points at a deleted user.

## What you get

**Full parity with the in-brain agents.** Every tool a Mantle agent can be
granted is on this surface. The client IS the owner, authenticated, driving
their own brain, so it is not given a smaller catalog than an agent running
inside the box. Two exceptions, both named below.

| Area | Tools |
|---|---|
| Search | `search` (hybrid semantic+keyword), `search_chunks` (passage-level), `tree_list`, `node_read`, `read_section` |
| Knowledge graph | `entity_search`, `entity_facts`, `entity_neighbors`, `entity_mentions`, `graph_path` |
| Recall | `recall_index`, `recall_open`, `recall_go`, `recall_match` |
| Content | `note_*`, `task_*`, `event_*`, `journal_*` (full CRUD), `page_*`, `table_*`, `draw_*`, `content_supersede` |
| Files | `folder_*`, `file_*` (list/read/create/upload/move/copy/delete), `show_image`, `export_node`, `sheet_build` |
| Email | `email_list`, `email_get`, `email_send`, `email_page` (sending is gated by the contacts allowlist, same as for the responder) |
| Sandboxes | `sandbox_create` / `sandbox_exec` / `sandbox_list` / `sandbox_stop` / `sandbox_rm` / `sandbox_export` / `sandbox_publish` / `sandbox_mcp_*` — isolated Ubuntu containers to run code in (docs/sandboxes.md); needs the `sandboxes` compose profile, and says so plainly when it is off |
| Research | `web_search`, `web_search_pro`, `web_fetch`, `web_map`, `web_crawl`, `video_ingest` — these reach the open internet and bill your keys |
| Compute | `calculate`, `formula_*` |
| Apps | `app_*` (author, build, publish), `app_db_list`, `app_db_query` |
| Toolsmith | `api_tool_*`, `tool_group_*`, `agent_*`, `recipe_tool_*` (writes gated by `MANTLE_MCP_TOOLSMITH_WRITE`) |
| Runs | `run_plan`, `run_append`, `run_state`, `run_cancel`, `run_audit` (creation also needs `MANTLE_RUNS=1` on the box) |
| Team Chat (owner side) | `team_chat_list`, `team_chat_read`, `team_access_list`, `team_member_list`, `team_notify` |
| Telegram | `telegram_pending`, `telegram_send` (allowlisted chats only), `telegram_react`, `telegram_edit`, `telegram_pair` |
| Replay | `find_window`, `replay_window` |
| Operator | `pending_list` / `pending_get` / `pending_approve` / `pending_reject` |
| Federation | `peer_list`, `peer_query`, `peer_search_chunks`, `peer_node_get` |
| Owner state | `update_persona`, `set_timezone`, `secret_create`, `node_share`, `node_unshare`, `process_extraction`, `brain_capacity` |
| Models | `model_catalog`, `model_pool_*`, `openrouter_*`, `recall_eval` |
| Responder | `ask_responder`, `ask_as_responder`, `respond_as_agent`, `invoke_agent` |
| Location | `location_save`, `location_nearby`, `location_distance`, `route_map` |

### The two that are not on it

- **`run_terminal`** — a shell in the brain's OWN container: postgres, minio,
  the file store, the master key. Over **stdio** it ships, because spawning the
  process already grants the owner's full data access on a machine you control.
  Over the **HTTP connector** it is off, because a stolen bearer would become a
  root shell on the box; set `MANTLE_MCP_TERMINAL=1` in the box's `.env` to turn
  it on anyway, or `=0` to turn it off for stdio too. `sandbox_exec` is the
  contained alternative and is always available on both.
- **`synthesize_speech`** — needs a live delivery surface (a Telegram chat, the
  web reply stream) to play audio into. Over MCP it could only ever error.

A gap of any other kind is a bug: `packages/mcp-core/src/bridge.test.ts` fails
the build when a builtin tool is not registered here.

Things to try: *"search my Mantle for …"*, *"any unanswered Telegram
messages? draft replies"*, *"what do I know about \<person\>?"*, *"log a
memory: …"*, *"approve the pending tool calls if they look sane"*.

### Talking to a responder agent

Everything above is *persona-less* raw data access. Two tools are the
exception, and the difference between them matters.

#### `ask_responder` — the brain answers, and the rules are enforced

Sends a message **as if you were the user talking to one of your responder
agents**, and runs ONE real turn of that agent's pipeline server-side: its
composed persona (identity + skills), real memory retrieval, and its real
granted tools, which **execute** (delegation via `invoke_agent` included).
It's the "Agent Studio sandbox, but with the real tool loop".

The one thing it does *not* do is persist: **nothing is written to the
agent's conversation history** (no inbound/outbound rows, no usage bump) so
you can probe a responder repeatedly without polluting its memory of talking
to you. The turn is traced like any other (the reply carries a `trace_id`
for `/traces`).

Because nothing is stored, **multi-turn is caller-held**: keep the transcript
yourself and resend it in `history` on each call. Omit `agent_slug` for the
default responder; pass `max_iterations` to cap the loop, or
`include_tool_calls: false` to drop the per-call trail from the reply.

> Renamed from `respond_as_agent`. The old name read as "respond *as* the
> agent", which is what `ask_as_responder` does — this tool gets a response
> *from* one. `respond_as_agent` still works as a deprecated alias for one
> release.

##### `read_only`: the flag to use for a canary

By default **tool side effects are real** — a note gets created; a
confirm-gated call lands on `/pending`, returned as `pending_ids`. That makes
the obvious use (a post-deploy smoke test on a live box) unsafe: the model
could decide to send mail.

Pass **`read_only: true`** and the turn keeps only tools the registry marks as
mutating nothing and sending nothing outward. It is **default-deny**: a tool
is excluded unless it has been explicitly marked safe, so a new write or
egress tool is locked out the day it ships, and user-defined API/recipe tools
are never included. `invoke_agent` is deliberately excluded — a child agent
carries its own write grants. The filter is applied last, after every other
step, so nothing can add a write tool back.

`exclude_tools` still works and composes with it: `read_only` sets the safe
ceiling, `exclude_tools` narrows further.

```jsonc
// A canary that cannot write or send anything.
{ "message": "Name three things you know about project X, with citations.",
  "read_only": true }
```

#### `ask_as_responder` — you answer, and the rules are only advice

Returns the responder's **composed system prompt**, its skill list, the tool
slugs it would hold and its delegation edges, so *you* can answer as that
persona in your own loop. No model call, no tool run, nothing written.

Use it to sound and reason like the responder across a long stretch of your
own work, with your own model, without a server round trip per turn.

> ⚠️ **What comes back is teaching, not permission.** The composed prompt is
> real, but nothing in the payload constrains you: `delegate_to` is a list
> rather than a gate, `tool_slugs` is what the responder *would* be granted
> rather than what you can call, and confirm-gating, `/pending` parking and
> the loop guards all stay on the server. When the rules must actually hold,
> use `ask_responder` and let the brain run the turn.

Contrast both with the in-app Agent Studio sandbox
([`agent-studio.md`](./agent-studio.md)), which composes the same prompt but
makes a plain model call with tools and memory OFF.

## Caveats

- **Cold spawn** takes a few seconds (tsx compiles on first request after
  launch); each call over SSH adds a network round trip. Fine for chat.
- **Writes are real.** There is no sandbox: a `task_create` from Claude
  Desktop is the same row the web app shows, and the extractor will index
  whatever Claude writes. For a responder probe that cannot write, use
  `ask_responder` with `read_only: true`.
- **One config per client machine.** stdio means there's nothing to
  centrally provision; each device that should reach the Mantle needs SSH
  access and the config blob once.
