# Activity → Reaction: what lands where

The map of **every way a human (or the system) puts something into the brain,
and which "brain areas" react.** When you take an action — type in chat, drop a
PDF, receive an email, write a note — Mantle opens a trace and runs one or both
of its reaction pipelines. This doc is the durable reference for that mapping;
the **Journey** screen at `/debug → Journey` (`/debug/journey`) is the live,
per-item view of the same thing.

Companion to [`memory.md`](./memory.md) (what the six layers *are*),
[`observability.md`](./observability.md) (the trace model), and
[`data-flow-tracing.md`](./data-flow-tracing.md) (how to verify one item by hand).

> **Keep this in sync with the code.** If the "brain dance" changes — a new
> ingest source, a new node type, a new trace kind, a new layer — update this
> table *and* the source-of-truth files listed in [§4](#4-source-of-truth-keep-these-aligned).

---

## 1. The two pipelines (+ automation)

Every action feeds one or both of these:

| Pipeline | Flow | Triggered by |
|---|---|---|
| **① Content** (you *add knowledge*) | `L6 content_store → L5 content_index → L4 profile facts → graph edges` | Any insert into `nodes` fires `pg_notify('node_ingested')` → the extractor runs the cascade. |
| **② Dialog** (you *talk*) | `L2 recent_turns → L3 conversation_digest → L1 persona` | A chat turn lands as recent turns; the summarizer rolls them into digests; the reflector distils persona notes. |
| **Automation** (the brain on its own clock) | timers + heartbeats | Summarizer / reflector timers; heartbeat-fired actions. |

The universal mechanism for pipeline ① is the key insight: **it doesn't matter
who created the node** (you, an agent tool, the email worker) — the insert fires
`node_ingested`, and the extractor reacts identically. That's why every ingest
traces the same way.

The six layers (see [`memory.md`](./memory.md) for the full treatment):

| # | Layer | What it holds |
|---|---|---|
| L1 | `persona` | The agent's identity + accumulated persona notes (what it has *learned*). |
| L2 | `recent_turns` | The last N raw chat exchanges. |
| L3 | `conversation_digest` | Compressed summaries of older conversations. |
| L4 | `profile` | Durable, dedup'd facts about the user and their world. |
| L5 | `content_index` | Searchable catalogue: title, summary, tags, entities, embedding. |
| L6 | `content_store` | The source content itself (the `nodes` row), immutable + citable. |

---

## 2. The map — action → reaction

| Your action | Source tag (`trace.data.source`) | Node created | Trace kind | Brain areas it lands in |
|---|---|---|---|---|
| Type in chat (web `/assistant`) | `assistant` | — (turn row) | `responder_turn` | **L2** → (timer) **L3** → (timer) **L1** |
| Type in chat (Telegram) | `telegram` | — (turn row) | `responder_turn` | **L2** → (timer) **L3** → (timer) **L1** |
| Drop a **PDF / DOCX** in chat | `assistant_upload` | `file` | `content_ingest` + `extractor_run` | **L6 · L5 · L4 · graph** — *PDF with no text layer = L5 filename only (no OCR)* |
| Drop an **image** in chat | `assistant_upload` | `file` | `photo_ingest` + `extractor_run` | **L6 · L5 · L4 · graph** (vision summary) |
| Upload a file (Files screen) | `file_upload` | `file` | `extractor_run` | **L6 · L5 · L4 · graph** |
| Create / edit a file via tool | `file_create` / `file_edit` | `file` | `extractor_run` | **L6 · L5 · L4 · graph** |
| Write a note | `note_create` | `note` | `extractor_run` | **L6 · L5 · L4 · graph** |
| Create event / task | UI / MCP | `event` / `task` | `extractor_run`¹ | **L6 · L5** (+ **L4** if facts enabled) |
| **Email arrives** (IMAP) | email worker | `email` / `email_thread` | `extractor_run` | **L6 · L5 · L4 · graph** |
| Send media via Telegram | `telegram_upload` | `file` | `photo_ingest` + `extractor_run` | **L6 · L5 · L4 · graph** |
| Agent acts via a tool | `agent_tool` | varies | inside `responder_turn` + `extractor_run` | **L6 · L5 · L4** |
| Conversation roll-up | — | `conversation_digest` | `summarizer_run` | **L3** (reads L2) |
| Persona reflection | — | — | `reflector_run` | **L1** (reads L2/L3) |
| Heartbeat / automation | scheduler | varies | `heartbeat_fire` | depends on the action |

¹ Only if the node type is allow-listed in the extractor's `memory_config.extract_types`.

The full set of **trace kinds** (`TraceKind` in `packages/tracing/src/store.ts`):
`responder_turn`, `extractor_run`, `summarizer_run`, `reflector_run`,
`photo_ingest`, `content_ingest`, `heartbeat_fire`, `manual`.

---

## 3. Reading it on the Journey screen

`/debug/journey` renders this map live:

- **Feed** — one row per action with a source icon, the plain-English label, status, and cost. Filterable by pipeline category (Content / Dialog / Automation) and a **Processed only** toggle that hides no-op skips (`body_too_short`, `already_extracted`, `no_new_activity`, …) so you see only traces that did real work. Note: `telegram_message` nodes are classified as **Dialog** even though the extractor fires on them — the conversation/transcript lives in L2 (recent turns), and these nodes mostly skip `body_too_short` by design.
- **Detail** (`/debug/journey/<traceId>`) — the reaction story for one action:
  - **What happened** — the trace step timeline (e.g. `llm_extract → embed_batch → update_index → reconcile_entities → process_facts`).
  - **Where it landed in your brain** — the actual L6 node, L5 summary + `embedding ✓/—` + `body text ✓/—` + tags, L4 facts, and the graph entities.

This makes gaps self-evident: a scanned PDF with no text layer shows **L5 ✓ but
body text —**, so the missing-OCR case is visible at a glance.

`/debug` (the **Operator** tab) stays the raw widget view; **Journey** is the
human story view. Both read the same `traces` / `trace_steps` tables.

---

## 4. Source of truth — keep these aligned

When the brain dance changes, update this doc alongside:

| Concern | File |
|---|---|
| Trace kinds | `packages/tracing/src/store.ts` (`TraceKind`) |
| Ingest source tags | callers of `recordIngest()` (e.g. `apps/web/app/api/{assistant/turn,files,notes}/…`, `apps/agent/src/main.ts`) |
| The `node_ingested` → extractor cascade | `apps/agent/src/extractor.ts` |
| Node types | `packages/db/src/schema/nodes.ts` (`node_type` enum) |
| The 6 layers | [`memory.md`](./memory.md) |
| Action → label/category/icon mapping | `apps/web/lib/journey-format.ts` (`deriveAction`) — covered by `journey-format.test.ts` |
| Journey data layer | `apps/web/lib/journey.ts` (`listActivity`, `getJourney`, `loadLanded`) |
| Journey screens | `apps/web/app/(app)/debug/journey/*` |
