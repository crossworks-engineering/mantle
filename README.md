# Mantle

**A self-hosted brain for everything you know.** Mantle turns your emails,
files, notes, documents, conversations, contacts, events, and projects into
one living, AI-queryable memory — owned by you, running on your hardware,
with agents that genuinely remember.

You talk to it on the web or Telegram (text or voice). You connect Claude to
it over MCP. You drop a PDF in chat and it's indexed before you've finished
your sentence. You mention "that gantry note from April" and it knows exactly
which one — because it read it, summarised it, extracted the facts, linked
the people and projects, and filed every receipt.

---

## The brain is the product

Most AI assistants are a chat window with amnesia. Mantle is built the other
way around: the **memory system** is the core, and chat is just one doorway
into it.

Every piece of content that enters — an email, a voice note, a spreadsheet, a
journal entry — flows through one pipeline into six layers of memory:

| Layer | What it holds |
|---|---|
| **Persona** | who your assistant is, and what it has learned about how you want to be helped |
| **Recent turns** | the live conversation, across every channel |
| **Digests** | older conversation, compressed by topic and embedded for recall |
| **Profile facts** | durable, deduplicated truths about you and your world — updated, superseded, never duplicated |
| **Content index** | a searchable spine over every item: summary, entities, vectors, passage-level chunks |
| **Content store** | the originals — append-only, citable, yours |

On top of that sits a **knowledge graph** (who works where, what banks with
whom — extracted automatically, traversable in milliseconds) and **lossless
recall**: when a summary isn't enough, a specialist agent replays the *actual
words* of any past conversation window.

The result is an assistant that picks up where you left off — last week or
last year. No sessions. No "as an AI, I don't have memory of previous
conversations." One continuous relationship.

## Who it's for

**One person, one life.** Your inbox, your files, your journal, your todo
list, your contacts, your secrets (sealed — the AI physically cannot read
them) — finally in one place that answers questions. *"When does Sarah's
passport expire?" "What did the electrician quote in March?" "What did we
decide about the kitchen?"* It knows, and it shows the receipt.

**A team's working memory.** Notes, pages (Notion-style documents), typed
tables, shared files — every artifact indexed and queryable, with public
share links for anything worth publishing, and Mantle-to-Mantle
**federation** for exchanging scoped data between sovereign instances.

**A company's knowledge base behind an MCP chatbot.** Point a Mantle instance
at your documentation, manuals, and internal know-how; it becomes a
fully-indexed brain — semantic search, passage retrieval, knowledge graph —
that any MCP client (Claude, or your own chatbot built on the same protocol)
can query with ~30 tools. Your support bot stops hallucinating answers and
starts citing your actual docs.

One brain per install. What that brain holds — a life, a team, a product —
is up to you.

## Why it's different

**It's genuinely yours.** Self-hosted, single binary of Docker services, no
SaaS in the runtime path. Embeddings are computed **locally** (bundled
Ollama; the vectors never leave your box, and they cost $0). Secrets and
credentials are AES-256-GCM sealed; the extractor is structurally unable to
read a secret's payload. Scheduled backups are built in — point your own
rsync/restic at one folder and the whole brain is portable.

**One Postgres, no zoo.** Vector search (pgvector), the knowledge graph
(recursive CTEs), full-text search, job queues, real-time UI updates, auth —
all one database. No Pinecone, no Neo4j, no Redis, no message broker. The
lean stack is what's left after deleting every moving part personal-scale
data doesn't need — which is also why it restores from one `pg_dump`.

**Engineered to be cheap.** Frontier-model quality where it matters (your
conversations), economy models for background compression, local embeddings
for everything vector. Prompt prefixes are kept byte-stable for provider
caching; oversized tool results spill to an addressable store instead of
re-billing every turn. Measured on the author's production instance: a full
question-answer turn against the whole brain averages **~$0.09**, and a month
of real daily use ran **under $5** in total LLM spend.

**Agents with jobs, not just a chatbot.** Your main assistant has a persona
that evolves, tools to act with (notes, events, email send, image
generation, page authoring…), and specialists it delegates to: **Remy**
replays past conversations losslessly, **Researcher** searches the web and
cites, **Pages**/**Tables** edit documents block-by-block. Proactive
**heartbeats** let it check in on schedules you define. Voice in, voice out.

**Nothing happens without a trace.** Every ingest, every extraction, every
tool call, every model invocation becomes a queryable trace with cost
attribution — rendered as a live "what did the brain just do" journey view.
A standing integrity audit watches the corpus for drift (half-indexed nodes,
stale backups, dead-lettered jobs) and says exactly how to heal each one.

**It knows who you are.** Life Logs — short first-person entries about who
you are, what you do, how you feel — are distilled into an always-on identity
block every agent reads on every turn. You tell the brain who you are in your
own words; it doesn't have to guess.

## Quick start

```bash
git clone https://github.com/TitanKing/mantle && cd mantle
pnpm install
cp .env.example apps/web/.env.local   # two generated secrets — see the guide
ollama pull embeddinggemma            # local dev only; production bundles it
pnpm start
```

Open http://localhost:3000, create your account, and the onboarding wizard
takes it from there: model keys, your assistant's personality, who you are.

Full walkthrough (local dev, email, Telegram, production deploy):
**[docs/getting-started.md](./docs/getting-started.md)** ·
**[docs/deploy.md](./docs/deploy.md)**

## The doorways

| Surface | What it gives you |
|---|---|
| **Web app** | chat with attachments + voice, inbox, files, notes, pages, tables, todos, events, contacts, life logs, secrets, traces, settings |
| **Telegram** | your assistant in your pocket — text, voice notes (transcribed + spoken replies), photos, documents |
| **MCP** | ~30 tools exposing the whole brain to Claude or any MCP client — search, graph traversal, files, email, pending-approval flows |
| **Share links** | revocable read-only links to any page, note, file, or event |
| **Federation** | two sovereign Mantles exchanging explicitly-granted data — peers, not tenants |

## Docs

**Start here**
- [`getting-started.md`](./docs/getting-started.md) — setup: dev stack, first run, email, Telegram, keys, agents.
- [`architecture.md`](./docs/architecture.md) — the full tour: processes, data plane, the `nodes` abstraction, pipelines, workspace. Read before touching code.
- [`deploy.md`](./docs/deploy.md) / [`update-prod.md`](./docs/update-prod.md) — production install + the update loop.
- [`onboarding.md`](./docs/onboarding.md) — the first-run wizard.

**The brain**
- [`memory.md`](./docs/memory.md) — the six layers, vector vs graph retrieval, and §7's as-built prompt assembly.
- [`knowledge-graph.md`](./docs/knowledge-graph.md) — entity↔entity relations, multi-hop traversal, why Postgres and not Neo4j.
- [`recall.md`](./docs/recall.md) — Remy: lossless time-windowed replay of past conversation.
- [`recall-eval.md`](./docs/recall-eval.md) — the retrieval eval harness; every ranking knob has a measured number behind it.
- [`conversation.md`](./docs/conversation.md) — one conversation stream across every channel.
- [`lifelog.md`](./docs/lifelog.md) — Life Logs and the always-on identity block.
- [`journey.md`](./docs/journey.md) — the Activity → Reaction map: every way content enters, and what reacts.

**Content & surfaces**
- [`pages.md`](./docs/pages.md) — Notion-style documents (TipTap, draft/commit, block-addressed AI editing).
- [`tables.md`](./docs/tables.md) — typed database grids (formulas, views, xlsx/csv import).
- [`files.md`](./docs/files.md) / [`file-ingestion.md`](./docs/file-ingestion.md) — the host-mirrored filesystem + how every file path indexes.
- [`email-ingest.md`](./docs/email-ingest.md) / [`email-send.md`](./docs/email-send.md) / [`contacts.md`](./docs/contacts.md) — IMAP in, SMTP out, contacts as the allowlist gate.
- [`telegram.md`](./docs/telegram.md) / [`comms-channels.md`](./docs/comms-channels.md) — the Telegram bridge + generic channel binding.
- [`sharing.md`](./docs/sharing.md) — public read-only links.
- [`secrets.md`](./docs/secrets.md) — the sealed secrets surface and its threat model.

**Agents & AI**
- [`ai-workers.md`](./docs/ai-workers.md) — one-shot workers (extractor, summarizer, reflector, TTS/STT, vision, image-gen, embedding) + the provider adapter framework.
- [`agent-studio.md`](./docs/agent-studio.md) / [`tools-and-skills.md`](./docs/tools-and-skills.md) — building agents, granting tools, composing skills.
- [`research.md`](./docs/research.md) — the web-search specialist.
- [`heartbeats.md`](./docs/heartbeats.md) — the proactive loop.
- [`chat-failover.md`](./docs/chat-failover.md) / [`models.md`](./docs/models.md) / [`embeddings.md`](./docs/embeddings.md) — routing, model catalog, embedder choices.
- [`rich-writing.md`](./docs/rich-writing.md) — how the assistant authors real documents.

**Operations & trust**
- [`backups.md`](./docs/backups.md) — built-in scheduled backups + the restore drill.
- [`observability.md`](./docs/observability.md) / [`data-flow-tracing.md`](./docs/data-flow-tracing.md) — the trace model + verifying ingest by hand.
- [`system-integrity.md`](./docs/system-integrity.md) — the declarative manifest + standing integrity checks.
- [`federation.md`](./docs/federation.md) — Mantle-to-Mantle.
- [`tailscale.md`](./docs/tailscale.md) — reaching models on your own tailnet.
- [`handover-trust-model.md`](./docs/handover-trust-model.md) — **open work brief:** provenance tiers for untrusted content.

**Engineering journal** — the audits and overhauls that shaped the system:
[`hardening-audit-2026-05.md`](./docs/hardening-audit-2026-05.md) ·
[`agent-overhaul-2026-05.md`](./docs/agent-overhaul-2026-05.md) ·
[`audit-chat-cost-2026-06-07.md`](./docs/audit-chat-cost-2026-06-07.md) ·
[`docs/_archive/`](./docs/_archive/) for frozen session handoffs.

## License

Mantle is **dual-licensed** by Cross Works Engineering (Pty) Ltd:

- **[`LICENSE.md`](./LICENSE.md)** — the public **Functional Source License 1.1
  (MIT Future)** (`FSL-1.1-MIT`). Free to use, self-host, and modify for any
  purpose that is not a Competing Use; each release converts to MIT two years
  after publication.
- **[`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md)** — a paid commercial
  license for embedding Mantle in a product or running it as a service during the
  two-year window. Contact **licensing@crossworks.engineering**.
- **[`LICENSING.md`](./LICENSING.md)** — plain-language explainer of the model.
- **[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)** — attribution for the
  613 bundled open-source components. Regenerate with `pnpm licenses:notices`.
