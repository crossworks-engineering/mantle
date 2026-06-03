# Architecture overview

A one-page mental model of how Mantle is built, for the technically curious. You
don't need any of this to *use* Mantle — but if you want to understand what's under
the hood (or self-host with confidence), start here. Deep, file-cited developer
docs live alongside this guide (see the end).

## The shape

Mantle is a **single-user, self-hosted "AI-queryable life tree."** Three
constraints drive every decision:

- **Self-hosted** — no SaaS in the runtime path; it all runs on your machine.
- **Single-user** — the whole tree belongs to one person; no multi-tenancy.
- **Postgres-first** — if something can be a table, it's a table. Search, vectors,
  job queues, real-time events — all in Postgres. One database is the source of
  truth.

## The one big idea: everything is a node

Almost everything — an email, a file, a note, a page, a table, a contact, a secret,
a calendar event, a Telegram message, a doc — is a row in one **`nodes`** table,
arranged in a tree. Type-specific details hang off in companion tables, and big
binary bytes (attachments) live in object storage. One table means one search, one
ownership rule, one place memory grows.

## The brain pipeline

Adding anything fires the same reaction: a new node triggers the **extractor**,
which produces the memory — a summary, a meaning-embedding, searchable section
chunks, durable facts, and knowledge-graph links. Re-editing re-runs it cleanly
(rebuild, not pile-up). See [The brain](../02-concepts/01-the-brain.md) for the
plain-language version.

## The moving parts

- **Web app** (Next.js) — the UI you click, the API routes, and the web assistant.
- **Background workers** — ingest email, poll Telegram, watch the files folder, fire
  event reminders, and sync documentation.
- **The agent process** — runs the extractor and the Telegram responder, reacting to
  database notifications the instant content lands.
- **Postgres** — the source of truth, with extensions for vectors (pgvector),
  hierarchical paths (ltree), and full-text search.
- **Object storage** (MinIO/S3) — attachment bytes, content-addressed.
- **Models** — chat via your chosen providers (or local), embeddings local-and-free
  by default, all behind a uniform provider-adapter layer so you can swap providers
  without touching call sites.

Everything talks to the one Postgres; nothing depends on an external service to
function.

## How a turn flows

You send a message → the assistant assembles the relevant slices of memory (persona,
recent turns, digests, facts, matching documents) → it reasons, optionally calls
tools or a specialist agent (asking your approval for gated actions) → it replies,
and learns a little about your preferences. Every step is recorded (see
[Observability](02-observability.md)).

## The deep developer docs

This guide is the *user* documentation. Mantle also ships an extensive set of
*developer* docs in the repository's `docs/` folder — the exhaustive, file-cited
references behind everything above. The headline ones:

- `architecture.md` — the full system tour.
- `memory.md` — the six memory layers in depth.
- `ai-workers.md` — the workers + provider-adapter framework.
- `knowledge-graph.md` — entity resolution and graph traversal.
- `embeddings.md`, `chat-failover.md`, `tailscale.md`, `observability.md`,
  `deploy.md`, and more.

These make up the built-in **System docs** collection, which ships **disabled**
(it's infrastructure-level material). If you want the assistant to be able to answer
deep "how is this implemented?" questions too, enable it at
[Settings → Documentation](../04-configuring/05-documentation-collections.md) — but
heads-up, it covers the whole `docs/` folder, so don't enable it alongside this
User Guide collection (which lives inside it).
