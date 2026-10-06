# Architecture

Mantle is a self-hosted brain: one server, one Postgres database as the source of truth, and Jackdaw as the window you work through.

## The shape

```
Jackdaw (web, desktop)         Claude and other MCP clients
           \                        /
            HTTPS: /api and /api/mcp
                       |
   Mantle server: web + runner + workers  <--  email, Telegram, calendars
                       |
      Postgres  +  object store (file bytes)
```

- **Jackdaw** is the product you click: the web app and the desktop app. It talks to Mantle only over `/api`.
- **Mantle** is the engine. It holds the data, runs the agents and answers MCP clients.

## The parts of the server

| Part | What it does |
| --- | --- |
| **Web** | Serves every `/api` route and the MCP endpoint at `/api/mcp` |
| **Runner** | Runs each assistant turn, the memory work (summaries, facts, digests) and heartbeats. A turn survives a restart and carries on |
| **Workers** | One per job, for example email sync, Telegram, files, calendars and event reminders |
| **Postgres** | Every item, search index, meaning vector, fact and job queue |
| **Object store** | The bytes of files and attachments (RustFS, or any S3) |
| **Helpers** | Document parsing and a headless browser for rendering |

Optional services add media conversion, a local embedder and code sandboxes ([Optional services](../05-admin/04-services.md)).

## Everything is a node

An email, a file, a note, a page, a table, a contact or an event is one row in one `nodes` table, arranged in a tree. One table gives one search, one access rule and one place where memory grows. When a node is added or changed, the database signals the runner, which reads it and updates the memory ([How Mantle remembers](02-memory.md)).

## One brain, one owner

Each server is one brain with one owner. Team members and clients get their own logins with limited rights; Postgres row rules decide what each one reads. Two brains talk only through federation ([Sharing and federation](06-sharing-and-federation.md)).

## Example: one question

You ask in Jackdaw, "What did the plumber quote?"

1. Jackdaw sends the message to `/api`, and the web part queues the turn.
2. The runner gathers memory: the matching email, its facts, recent chat.
3. The model answers, calling tools if it needs them.
4. Jackdaw shows the reply as it streams, with the email as its source.

Every step is recorded in **Traces** ([Traces, debug and integrity](../05-admin/09-observability.md)).

## Next

- [Choose how to install](../01-install/01-choose.md)
- Deep developer reference: [architecture.md](../../architecture.md)
