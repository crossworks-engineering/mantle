# Mantle

**A second brain that's actually awake.** Most AI assistants are a chat window
with amnesia — they wait for you to ask. Mantle ingests your emails, files,
notes, conversations, contacts, and calendar into one structured memory you
*own*, running on your hardware — and then works on its own, in the
background, so things happen without you asking.

You talk to it on the web or Telegram (text or voice). You connect Claude to
it over MCP. You drop a PDF in chat and it's indexed before you've finished
your sentence. But the part you can't get anywhere else: while you sleep, it
reads your inbox, files the receipts, surfaces the thing you forgot, and texts
you a morning briefing — and you never opened the app. It read every item,
summarised it, extracted the facts, linked the people and projects, and acted.

---

## The brain is the product — and it's awake

Mantle is built backwards from every chat app: the **memory substrate** is the
core, chat is just one doorway, and an autonomous agent *lives inside* the
substrate rather than visiting it. Two things make that work — and neither is a
weekend feature a competitor bolts on.

The first is a **real structure, not a vector pile.** Every item that enters —
an email, a voice note, a spreadsheet, a journal entry — flows through one
pipeline into a typed, owned data model with six layers of memory:

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

## Awake — and safe to leave running

A brain that only answers when asked is a database with a chat skin. Mantle's
second half is that it *acts*: **heartbeats** run agent routines on schedules
you set, ingestion pipelines feed it from email, Telegram, files, and voice
without you lifting a finger, and it can even **build its own API tools** to
reach the services you use. It works while you're not looking — the difference
between a thing you query and a thing that helps.

Which is exactly why the boundary matters, and why most of the engineering is
there. An autonomous brain that reads your inbox is a prompt-injection target,
so Mantle treats every ingested email, web page, and message as **data, never
instructions**: a malicious message can't make it leak your secrets, the tools
an agent builds for itself stay confirm-gated until you approve them, outbound
email is locked to your own contacts, and `web_fetch` can't be steered into
your internal network. **"Autonomous" and "safe to leave running" in the same
sentence is the thing no chat app and no hosted assistant can say** — because
none of them act on your whole life to begin with. Underneath it: AES-256-GCM
sealed secrets, owner-scoped everything, and a test suite that pins the trust
boundary in place.

(And the horizon: **federation** — sovereign Mantles answering scoped queries
for each other, brains that talk to brains. It's the endgame, not the opening.)

## Who it's for

**One person, one life.** Your inbox, your files, your journal, your task
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
SaaS in the runtime path. Embeddings default to a strong online model
(`text-embedding-3-large`, reduced to 768 dims, riding the same OpenRouter
key as chat) — and for boxes where vectors must never leave the machine, a
bundled **local embedder** (Ollama) is one compose profile away. Secrets and
credentials are AES-256-GCM sealed; the extractor is structurally unable to
read a secret's payload. Scheduled backups are built in — point your own
rsync/restic at one folder and the whole brain is portable.

**One Postgres, no zoo.** Vector search (pgvector), the knowledge graph
(recursive CTEs), full-text search, job queues, real-time UI updates, auth —
all one database. No Pinecone, no Neo4j, no Redis, no message broker. The
lean stack is what's left after deleting every moving part personal-scale
data doesn't need — which is also why it restores from one `pg_dump`, and
why the whole running system idles at **~2.5 GB RAM**: a modest 4 GB VPS
carries your entire brain.

**It builds a personality around you — and it never forgets.** While you
talk, a background reflector quietly studies the conversation and appends
what it learns to your assistant's standing persona: how you like to be
answered, what you corrected, the running jokes, the names that matter. Tell
it once that you hate bullet points, and that's simply who it is from then
on. And nothing falls off the back of the context window: recent turns stay
raw, older conversation is compressed into topic digests, durable facts are
distilled and kept current — and when a summary isn't enough, a recall
specialist replays the *actual words* of any past conversation, from last
Tuesday or last year. There is no "new chat". There is one relationship that
compounds.

**Context that targets the question.** Mantle doesn't dump your life into
the prompt. Each turn, your message is embedded and the brain retrieves
*just* what this question needs: the top facts, the right documents — down
to the exact passages — and the graph relationships of the entities
involved, ranked by relevance, recency, and salience (a newsletter can never
crowd out a real letter). Short follow-ups like "tell me more about that"
are enriched with conversational context before retrieval, so they land too.
The model sees a small, surgical prompt instead of a haystack — which is why
answers are sharp, and why turns cost cents. Every ranking knob has a
measured eval number behind it, not a vibe.

**Engineered to be cheap.** Frontier-model quality where it matters (your
conversations), economy models for background compression, cheap embeddings
for everything vector (online by default; optionally local and $0). Prompt
prefixes are kept byte-stable for provider
caching; oversized tool results spill to an addressable store instead of
re-billing every turn. Measured on the author's production instance: a full
question-answer turn against the whole brain averages **~$0.09**, and a month
of real daily use ran **under $5** in total LLM spend.

**Agents with jobs, not just a chatbot.** Your main assistant has tools to
act with (notes, events, email send, image generation, page authoring…) and
specialists it delegates to: **Remy** replays past conversations losslessly,
**Researcher** searches the web and cites, **Pages**/**Tables** edit
documents block-by-block. Proactive **heartbeats** let it check in on
schedules you define. Voice in, voice out.

**Nothing happens without a trace.** Every ingest, every extraction, every
tool call, every model invocation becomes a queryable trace with cost
attribution — rendered as a live "what did the brain just do" journey view.
A standing integrity audit watches the corpus for drift (half-indexed nodes,
stale backups, dead-lettered jobs) and says exactly how to heal each one.

**It knows who you are — because you told it.** The learned personality
above is one half; **Journal** entries are the other: short first-person entries
about who you are, what you do, how you feel, distilled into an always-on
identity block every agent reads on every turn. What it observes, it learns;
what you declare, it never has to guess.

## Quick start

Run it — published Docker image, secrets generated for you, everything else
configured in the interface:

```bash
curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh | bash
```

Open http://localhost, create your account, and the onboarding wizard takes
it from there: model keys, your assistant's personality, who you are.
Updating is `docker compose pull && docker compose up -d --wait`. Full guide
(domains/HTTPS, pinned versions, backups, rollback):
**[docs/self-hosting.md](./docs/self-hosting.md)**

Hack on it — dev checkout with hot reload:

```bash
git clone https://github.com/crossworks-engineering/mantle && cd mantle
pnpm install
cp .env.example apps/web/.env.local   # two generated secrets — see the guide
brew install ollama && brew services start ollama   # optional: local embedder
ollama pull embeddinggemma            # opt-in local path (the default embedder is online, chosen in onboarding)
pnpm start
```

Full walkthrough (local dev, email, Telegram, production deploy):
**[docs/getting-started.md](./docs/getting-started.md)** ·
**[docs/deploy.md](./docs/deploy.md)**

## The doorways

| Surface | What it gives you |
|---|---|
| **Web app** | chat with attachments + voice, inbox, files, notes, pages, tables, tasks, events, contacts, journal entries, secrets, traces, settings |
| **Telegram** | your assistant in your pocket — text, voice notes (transcribed + spoken replies), photos, documents |
| **MCP** | ~30 tools exposing the whole brain to Claude or any MCP client — search, graph traversal, files, email, pending-approval flows |
| **Share links** | revocable read-only links to any page, note, file, or event |
| **Federation** | two sovereign Mantles exchanging explicitly-granted data — peers, not tenants |

## Docs

**Start here**
- [`self-hosting.md`](./docs/self-hosting.md) — run Mantle from the published image: one-line install, updating, rollback.
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
- [`journal.md`](./docs/journal.md) — Journal and the always-on identity block.
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
