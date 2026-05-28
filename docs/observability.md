# Observability

How Mantle records what its agents do. Companion to
[`architecture.md`](./architecture.md) and [`memory.md`](./memory.md);
this file is the durable reference for the tracing layer. For the
human-readable view of the same traces — *what action you took and which
brain layers reacted* — see [`journey.md`](./journey.md) and the
**Journey** tab at `/debug/journey`.

Status: **live.** Every responder turn, extractor run, summarizer
pass, reflector tick, **content ingest moment, and Telegram photo
ingest** produces a `traces` row plus a tree of `trace_steps`. The
`/traces` page renders each as a reactflow graph; `/debug` aggregates
them into dashboard widgets; **`/nodes/[id]/history` joins all traces
that touched a specific node into a single biography timeline.**

The system's hard rule (Layer A, May 2026): **every pipeline decision
is visible**. Even when the extractor decides not to run on a node,
it records a `skipped` trace with a disposition string explaining
why. The previous behaviour (silent early-return) made "I uploaded a
file but I have no idea what happened" un-debuggable.

---

## 1. Why it's its own layer

Mantle has been multi-process and multi-agent for a while now. When
something goes wrong — or you just want to understand "what did the
system *do* the last time I sent a DM?" — console logs aren't enough.
You need:

- Every unit of work as a queryable row.
- Inputs, outputs, timing, and errors at every step.
- Aggregates across runs (cost per agent, top errors, cache hit rate).
- A visual that makes the flow obvious to a human.

That's what the tracing layer does. It's **not** memory — the
responder doesn't read traces back into its prompts. It's pure
operator observability, separate from the six memory layers.

---

## 2. The model

Two tables:

- **`traces`** — one row per *unit of work*. Always owner-scoped.
- **`trace_steps`** — ordered tree under each trace. Each step has
  a parent (or is a root), an ordinal within its parent, a `kind`
  (db_read / db_write / llm_call / embed / http / notify / compute /
  send), inputs / outputs / meta / error, and timing.

A trace is one of seven kinds (the `trace_kind` enum):

| Kind | When it fires | Subject |
|---|---|---|
| `responder_turn` | Inbound DM → reply (Telegram) **AND** web /assistant turn (distinguished by `data.surface`) | `telegram_message` id / `assistant_message` id |
| `extractor_run` | New `nodes` row of an extractable type — **runs even on early-return paths** (marked `skipped`) | `node` id |
| `summarizer_run` | Chat crosses the undigested-turn threshold | `chat` id |
| `reflector_run` | 10-minute timer fires — **runs even when no new activity** (marked `skipped`) | `agent_tick` (subject_id null) |
| `content_ingest` | Every data entry moment — file upload, note create, image upload via /assistant, Telegram photo → file, agent-tool file write | the resulting `node` id |
| `photo_ingest` | Image → save file + vision-transcribe pipeline. Fires from the Telegram photo branch (subject = `telegram_message`, reply is a separate `responder_turn`) AND from the extractor for images dropped into `/files` outside the chat (subject = `node`, `data.source='extractor'`) | `telegram_message` or `node` id |
| `manual` | Reserved for scripts + the `invoke_agent` builtin's child agent runs | (whatever) |

Each trace rolls up totals from its steps:
- `tokens_in`, `tokens_out`, `tokens_cache_read` — sum of LLM step usage.
- `cost_micro_usd` — sum of LLM step costs in 10⁻⁶ USD.
- `step_count` — total steps under this trace.
- `duration_ms` — wall-clock from start to finish.
- `status` — `running` (open), `success`, `error`, or `skipped`.

`skipped` is for **pipelines that consciously decline to run** — the
extractor finding a node it's already processed, the reflector
finding no new activity, etc. The disposition string in `data`
explains why (`already_extracted`, `body_too_short`,
`no_extractor_worker`, etc.). Filter `/traces?status=skipped` to see
what the system considered but declined to do.

A step's status is the same enum (`running` / `success` / `error` /
`skipped`).

---

## 3. How the code instruments work

Four primitives in `@mantle/tracing`:

```ts
// Full pipeline run with nested steps:
await startTrace(
  { kind, ownerId, subjectId, subjectKind, agentId, data },
  async () => { /* do work */ }
);

// Step inside a startTrace block:
await step(
  { name, kind, input },
  async (handle) => {
    // ... do step's work
    handle.setOutput({ ... });   // captured in trace_steps.output
    handle.setMeta({ ... });     // captured in trace_steps.meta
    handle.addTokens({ input, output, cacheRead });
    handle.addCost(microUsd);
  }
);

// "Pipeline chose not to run" — no fn execution, just a single
// row marking the decision:
await recordSkippedTrace({
  kind, ownerId, subjectId, subjectKind, agentId,
  disposition,           // 'already_extracted', 'no_extractor_worker', …
  details,               // structured payload for debugging
});

// "Something just entered the system" — fires at every data
// entry point so the node-biography page has an anchor:
await recordIngest({
  source,                // 'file_upload', 'note_create', 'telegram_photo', …
  ownerId,
  nodeId,                // the resulting node
  summary,               // one-line "what came in"
  payload,               // structured details (mime, size, source url)
  snippet,               // optional content snippet attached as step.input
});
```

Both `startTrace` and `step` propagate via `AsyncLocalStorage`. No
need to thread a `traceCtx` argument — `step()` automatically nests
under whichever `step()` is currently running, and reads from the
ambient `startTrace` context. `recordSkippedTrace` and `recordIngest`
do single-INSERT writes without changing the ambient context (they're
"this happened, period" facts, not work scopes).

**No trace, no overhead.** If `step()` is called outside a trace
(e.g. from the backfill script), it just runs the function — zero
database writes, zero allocations.

**Writes are fire-and-forget for inner steps.** `INSERT INTO
trace_steps` is never awaited on the hot path. The OPENING of a
trace (the row that step writes will FK against) IS awaited so a
concurrent-pool race can't leave orphaned steps.

**Soft-fail.** If a trace/step write hits the DB and fails (FK
violation, enum violation, network error), we log via
`console.error('[tracing] ...')` and continue. The user-visible
behaviour is preserved; the operator sees an error trail to debug
later. This is how the May-2026 agent_id-FK bug went undetected for
weeks — see "Soft-failing trace inserts swallow real bugs" below.

**Truncation.** `input`, `output`, and `meta` jsonb fields cap at
**64 KB serialised** per field; longer values get a `{ truncated,
originalBytes, head }` shape with the first 32 KB. Arrays cap at
200 items per slot. Operators have explicitly chosen "show me
everything" over compact traces — 64 KB comfortably fits the full
body of a 30-50 KB markdown file's `body_preview`, all extracted
entities + facts, and per-mention embed previews. The cap is still
real for catching a 1 MB Telegram webhook payload or accidentally-
stringified embedding vectors.

---

## 4. How LLM cost + tokens get captured

`apps/agent/src/llm-usage.ts` exposes `captureLlmUsage(handle,
result, model)`. Every site that calls OpenRouter wraps the call in
a `step('llm_call', …)` and feeds the raw response to this helper.
It reads `usage.promptTokens`, `usage.completionTokens`,
`usage.cacheReadInputTokens` (camelCase via the SDK; falls back to
snake_case for routes that don't normalise), calls
`handle.addTokens()` + `handle.addCost()`, and sets meta so the
trace detail UI can show "model · 14823+247 tokens".

Cost picks `usage.cost` if the route returns it; otherwise falls
back to a small price table in `packages/tracing/src/pricing.ts`
keyed by OpenRouter model slug. Stored as bigint micro-USD so we
keep integer math.

`addTokens` / `addCost` bubble to the parent step *and* the trace
totals on `finish`. The trace header shows totals without explicit
roll-up at each level.

---

## 5. Where each flow's tracing lives

| Flow | File | Trace kind | Top-level steps |
|---|---|---|---|
| Telegram responder turn | `apps/agent/src/main.ts handleMessage` | `responder_turn` (`subjectKind=telegram_message`) | load_context · build_messages · openrouter_chat · send_telegram · persist_outbound |
| Web /assistant turn | `apps/web/lib/assistant.ts runAssistantTurn` | `responder_turn` (`subjectKind=assistant_message`, `data.surface=web`) | openrouter_chat + per-tool steps from the tool loop |
| Extractor run | `apps/agent/src/extractor.ts extractNode` | `extractor_run` | llm_extract · update_index · reconcile_entities · process_facts |
| Extractor skip | (same) | `extractor_run` (status `skipped`) | (none — disposition + details in `data`) |
| Summarizer run | `apps/agent/src/summarizer.ts summarizeChat` | `summarizer_run` | load_batch · load_chat_account · llm_summarize · insert_digest_node · mark_turns_digested |
| Reflector run | `apps/agent/src/reflector.ts reflect` | `reflector_run` | load_recent_turns · llm_reflect · append_notes |
| Telegram photo ingest | `apps/agent/src/main.ts (photo branch)` | `photo_ingest` | download_photo · persist_file · extract_vision |
| Content ingest | various entry points | `content_ingest` | `received` step with content snippet |
| Embedder | `packages/embeddings/src/index.ts embedBatch` | (sub-step) | `embed_batch` step appears under whatever parent called it |

The embedder shows up as a nested `embed_batch` step inside the
parent it was called from (`reconcile_entities`'s per-mention embed,
`process_facts`'s per-fact embed, etc.). Each one captures the
**full preview of every input** as `input.preview` — so the
10-identical-cards problem in the graph view is solved: each
`embed_batch` row shows the actual mention names / entity refs /
fact texts it embedded. Cache hit / miss / api_call counts land in
its `meta`.

**No silent skips, by design.** Pipeline early-returns record
`skipped` traces with disposition strings — see Section 6 for the
full disposition catalog. Telegram-photo-ingest skips configuration
problems too (no vision worker, no api key) so the user gets a
clear ack-with-hint instead of silence.

**`content_ingest` is the entry-point anchor.** Every place that
calls `upsertFile` / `createNote` / Telegram-photo-handler / agent's
`file_create` tool follows up with a `recordIngest({source, nodeId,
summary, snippet})`. This is the trace the node-biography page
joins against to answer "where did this thing come from?".

### Content-ingest sources catalogued

| `data.source` | Origin |
|---|---|
| `file_upload` | `POST /api/files/files` multipart |
| `file_create` | `POST /api/files/files` JSON (text-file creation) |
| `file_edit` | `PUT /api/files/files/[id]` in-place edit |
| `note_create` | `POST /api/notes` |
| `assistant_upload` | image attached via /assistant chat |
| `telegram_photo` | Telegram photo → vision worker → note |
| `agent_tool` | Saskia's `file_create` tool call |

---

## 6. Disposition catalog — why something skipped

When `recordSkippedTrace` fires, `data.disposition` names the
reason. The current catalog (extend as new pipelines land):

### Extractor
- `fact_cost_cap` — **step-level, not trace-level.** The per-node fact
  budget (`extract_cost_cap_micro_usd`) was exhausted, so facts the LLM
  already produced were discarded before reaching the profile. The
  `process_facts` step is marked `status=skipped`; meta carries
  `fact_cost_cap=true` + `dropped` (count) + `model` so `/debug`'s "Facts
  dropped to cost cap" widget groups without a join. The enclosing
  `extractor_run` still finishes `success` (summary/embedding/entities did
  land) — this is the one place a partial-loss event lives on a step, not
  the trace. A cap of `0` / negative reads as **unlimited**; only a positive
  cap can drop facts.
- `no_extractor_worker` — no default extractor configured at /settings/ai-workers.
- `node_not_found` — race: notify fired but the row was already deleted.
- `hard_skip_type` — transient/internal type the extractor refuses by design.
- `type_not_in_allowlist` — node type isn't in the worker's `target_types`.
- `no_api_key_id` — worker exists but no API key attached.
- `api_key_not_decryptable` — key was deleted / KEK rotated.
- `already_extracted` — node has both `summary` and `embedding` already.
- `body_too_short` — body < 20 chars; usually a title-only node.
- `no_text_layer` — a PDF with no extractable text layer (scanned/image-only)
  where the OCR fallback also produced nothing (no/unwired vision worker, an
  unrenderable PDF, or a blank scan). Replaces the old silent failure where the
  filename fallback (≥20 chars) slipped past `body_too_short` and indexed a
  filename-only summary as `success`.

### Summarizer
- `no_summarizer_worker` — no default summarizer configured.
- `no_api_key_id` — same as above.
- (Threshold-not-met skips are NOT traced — they fire on every Telegram message
  and would flood the table; this is a deliberate exception to the "trace
  everything" rule.)

### Reflector
- `no_reflector_worker`
- `no_api_key_id`
- `no_responder_agent` — reflector edits persona_notes on the responder, so
  one must exist.
- `no_new_activity` — nothing happened since the last successful run.
- `api_key_not_decryptable`

### Tool-loop (step-level, not trace-level)
- `duplicate_in_response` — the model emitted multiple byte-identical
  `tool_use` blocks for the same call in one response. First was
  dispatched; this duplicate was suppressed to prevent write amplification.
  Meta carries `first_call_id` (the call that did dispatch) + `model` (so
  `/debug`'s "Duplicates suppressed by model" widget can group without a
  join). Step name is `tool: <slug>` (uniform with successful dispatches)
  + `kind=compute` + `status=skipped`. See [architecture.md §9n](./architecture.md#9n-in-response-duplicate-tool-call-guard).
- `requires_confirm` — tool was flagged `requiresConfirm: true`; a
  `pending_tool_calls` row was queued for the operator to approve at
  `/pending`. Meta carries `pendingId` + `requiresConfirm: true`.

`hint` is a free-text companion in `details` that points the
operator at the right action ("Add 'X' to the worker's target_types
param to extract it.").

---

## 7. Visual rendering — `/traces/[id]`

The detail page is a React Server Component for the header + a
client component (`trace-detail.tsx`) for the body. The body uses
`@xyflow/react` (reactflow v12) with `dagre` for top-to-bottom
auto-layout.

Each `trace_steps` row becomes one node, labelled with its name +
duration + a one-line summary inferred from `meta.model + tokens`,
`meta.cache_hits`, or `output.count`. Edges follow `parent_step_id`
when set; sequential edges chain root-level steps in `ordinal`
order. Status drives the border + background colour
(emerald / red / amber / slate).

Clicking a node fills a right-hand side panel with the step's
input / output / meta / error. With the May-2026 rich-preview
rollout, those fields show full content: the LLM prompt + body the
extractor saw, the entity/fact JSON the model produced, the
verbatim mention names each embed_batch processed.

No drag, no connect — read-only flowchart. Pan and zoom via
reactflow's built-in controls.

When the trace's subject is a node, the header's "Subject" field is
a link → `/nodes/<id>/history` so operators can pivot from "this one
trace failed" to "everything that touched this node."

---

## 8. Node biography — `/nodes/[id]/history`

The Layer-B answer to "what did the system do with my upload?".
Joins:

- The node row itself (current state: summary, embedding, content
  preview, tags).
- Every trace where `subject_id = node.id` ordered by `started_at`
  ascending — reads top-to-bottom as a story.
- For each trace, the full `trace_steps` tree with all
  input/output/meta jsonb shown in collapsible `<details>` blocks.

`skipped` traces render with a bright amber "Stopped here:
&lt;disposition&gt;" banner + the hint from `details`. Successful traces
render the trace-level data + each step with three collapsibles
(Input / Output / Meta). Errors render in destructive-red with the
error message above the steps.

Server-rendered, no client JS dependency — the page works when
other things are broken (which is when you most need a debug
surface). Native `<details>` elements for collapsibles.

Discoverable from:
- The "History" button in the file editor toolbar.
- The "Subject" field on `/traces/[id]` when the subject is a node.
- Deep link via `/nodes/<uuid>/history`.

---

## 9. Dashboard widgets — `/debug`

Five widget sections at the top of `/debug`, computed via
`apps/web/lib/metrics.ts`:

- **Last 24h** — total traces, success rate, avg duration.
- **Token spend (7d)** — total + top-2 spending agents.
- **Embed cache (7d)** — hit rate %, hits/misses/api_calls.
- **Failures (7d)** — total failed traces + distinct error
  signatures.
- **Top errors (7d)** — table grouped by first 80 chars of the
  error message, count + most-recent trace link.
- **Recent failed traces** — last 10 failures with one-click
  jump to the trace detail.
- **Daily spend (14d)** — bar strip of `traces.cost_micro_usd`
  bucketed by `date_trunc('day')`. Today is highlighted; empty
  days are zero-filled so the strip stays continuous.
- **Spend by model (7d)** — table joining `trace_steps` on
  `meta->>'model'`, summing `meta->>'cost_micro_usd'`. Includes
  both LLM chat calls and embedding calls, so you can spot
  which model is eating the budget.
- **Spend by agent (7d)** — table: runs, tokens in/out, cache
  reads, total cost.

All queries hit the `traces` + `trace_steps` indexes from the
0019 migration; no extra rollup table.

---

## 10. Adding a new trace kind

When a new flow goes live (e.g. a future research agent), add it:

1. Add the value to the `trace_kind` enum in a new migration:
   ```sql
   ALTER TYPE trace_kind ADD VALUE IF NOT EXISTS 'research_agent_run';
   ```
   (in its own breakpoint=true migration — see 0017_reflector_role for
   the pattern.)
2. Update `packages/db/src/schema/traces.ts` to include the new value.
3. Wrap the new flow's entrypoint in `startTrace({ kind: 'research_agent_run', … }, …)`.
4. Add a row to `KIND_LABEL` in `apps/web/app/(app)/traces/page.tsx`
   so the filter chip + table cells render the friendly name.

That's it. The list view, detail view, and dashboard widgets all
pick up the new kind automatically.

---

## 11. What we deliberately don't do

- **No auto-prune.** Single-user / single-VPS context; disk is cheap.
  Operator has explicitly chosen "show me everything" — that
  preference also drives the generous 64 KB / 200-item truncation
  budgets. If traces ever hit operational pain we can add a retention
  job pruning rows older than N days.
- **No OTel / Honeycomb export.** One Postgres, one operational story.
- **No streaming view.** Trace pages re-fetch on reload, no SSE.
- **No tracing of read-only Drizzle internals.** Drizzle calls inside
  a `step()` body are captured as part of the parent step's timing,
  not as their own steps. Otherwise every fact-search would produce
  a dozen low-signal rows.
- **No summarizer-threshold-check traces.** Summarizer's
  "undigested < N" check fires on every inbound Telegram message;
  tracing every one would drown the table. Layer A traces
  configuration-level skips only (no worker / no api key) where
  the signal is rare-but-actionable.
- **No drilling sub-steps inside `reconcile_entities` /
  `process_facts` per-iteration.** Each entity / fact instead lives
  in the parent step's `input.preview` (full list, names + kinds /
  contents). Cheaper than nested steps and still answers "which 12
  entities did this pass touch?".

---

## 12. Soft-failing trace inserts swallow real bugs

The tracing layer catches DB errors with `console.error('[tracing]
...')` and continues — by design, so a broken tracing layer can't
take down the agent. But this means **a category of inserts can fail
silently for a long time before anyone notices.** Two real incidents
worth committing to memory:

1. **The agent_id FK bug** (caught May 2026). After migration 0027
   moved extractor/summarizer/reflector from the `agents` table to
   `ai_workers`, the trace-opening code still passed `worker.id` as
   `agentId`. The FK to `agents` rejected every insert. Other trace
   kinds kept working (responder_turn uses a real agent.id), so
   the silence was kind-specific. The fix dropped the `agentId`
   column for those kinds; the worker reference lives in
   `data.worker_slug` + `data.worker_id` instead.

2. **The enum-missing bug** (also May 2026). Migration 0029 added
   `'skipped'` to `trace_status` and `'content_ingest'` to
   `trace_kind`. Drizzle's migration runner only picks up files
   listed in `meta/_journal.json` — hand-written SQL files need
   the journal entry added too. The Postgres enum stayed at the
   old values, every `recordSkippedTrace` / `recordIngest` insert
   FK-violated against the enum constraint, and Layer A appeared
   not to work because the SUCCESS path was unaffected. The fix
   added the journal entries.

Operator-facing tell: if you grep the agent's stdout for
`[tracing]` and see lines, that's where soft-failed inserts go.
The lines tell you the bug class (FK constraint vs enum violation
vs missing connection); the call site is usually obvious from
context.

---

## 13. Reading the code

If you only read four files in the observability layer, read in this
order:

1. [`packages/db/src/schema/traces.ts`](../packages/db/src/schema/traces.ts) +
   [`trace-steps.ts`](../packages/db/src/schema/trace-steps.ts) —
   the shape of the data.
2. [`packages/tracing/src/store.ts`](../packages/tracing/src/store.ts) —
   `AsyncLocalStorage` propagation, `startTrace` + `step`, the
   fire-and-forget writers.
3. [`apps/agent/src/llm-usage.ts`](../apps/agent/src/llm-usage.ts) —
   how OpenRouter usage gets normalised + rolled up.
4. [`apps/web/app/(app)/traces/[id]/trace-detail.tsx`](../apps/web/app/(app)/traces/%5Bid%5D/trace-detail.tsx) —
   how `trace_steps` rows become a reactflow graph (`dagre` layout,
   status-driven styling).

Aggregates at [`apps/web/lib/metrics.ts`](../apps/web/lib/metrics.ts);
list + detail queries at [`apps/web/lib/traces.ts`](../apps/web/lib/traces.ts).
