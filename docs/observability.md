# Observability

How Mantle records what its agents do. Companion to
[`architecture.md`](./architecture.md) and [`memory.md`](./memory.md);
this file is the durable reference for the tracing layer.

Status: **live.** Every responder turn, extractor run, summarizer
pass, and reflector tick produces a `traces` row plus a tree of
`trace_steps`. The `/traces` page renders each as a reactflow graph;
`/debug` aggregates them into dashboard widgets.

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

A trace is one of five kinds (the `trace_kind` enum):

| Kind | When it fires | Subject |
|---|---|---|
| `responder_turn` | Inbound DM → reply | `telegram_message` id |
| `extractor_run` | New `nodes` row of an extractable type | `node` id |
| `summarizer_run` | Chat crosses the undigested-turn threshold | `chat` id |
| `reflector_run` | 10-minute timer fires AND there's been outbound activity | `agent_tick` (subject_id null) |
| `manual` | Reserved for future scripts | (whatever) |

Each trace rolls up totals from its steps:
- `tokens_in`, `tokens_out`, `tokens_cache_read` — sum of LLM step usage.
- `cost_micro_usd` — sum of LLM step costs in 10⁻⁶ USD.
- `step_count` — total steps under this trace.
- `duration_ms` — wall-clock from start to finish.
- `status` — `running` (open), `success`, or `error`.

A step's status is the same enum plus `skipped` (used when a code
path returns early after entering the step body).

---

## 3. How the code instruments work

Two primitives in `@mantle/tracing`:

```ts
await startTrace(
  { kind, ownerId, subjectId, subjectKind, agentId, data },
  async () => { /* do work */ }
);

await step(
  { name, kind, input },
  async (handle) => {
    // ... do step's work
    handle.setMeta({ ... });
    handle.addTokens({ input, output, cacheRead });
    handle.addCost(microUsd);
  }
);
```

Both are propagated via `AsyncLocalStorage`. No need to thread a
`traceCtx` argument through every function — `step()` automatically
nests under whichever `step()` is currently running, and reads from
the ambient `startTrace` context.

**No trace, no overhead.** If `step()` is called outside a trace
(e.g. from the backfill script), it just runs the function — zero
database writes, zero allocations.

**Writes are fire-and-forget.** `INSERT INTO trace_steps` is never
awaited on the hot path. A slow Postgres or a tracing bug can't
slow down the agent's reply. If a write fails, it's logged but
never thrown.

**Truncation.** `input`, `output`, and `meta` jsonb fields cap at
2 KB serialised; longer values get a `{ truncated, originalBytes,
head }` shape. Avoids 200 KB email bodies bloating trace_steps.

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
| Responder turn | `apps/agent/src/main.ts handleMessage` | `responder_turn` | load_context · build_messages · openrouter_chat · send_telegram · persist_outbound |
| Extractor run | `apps/agent/src/extractor.ts extractNode` | `extractor_run` | llm_extract · update_index · reconcile_entities · process_facts |
| Summarizer run | `apps/agent/src/summarizer.ts summarizeChat` | `summarizer_run` | load_batch · load_chat_account · llm_summarize · insert_digest_node · mark_turns_digested |
| Reflector run | `apps/agent/src/reflector.ts reflect` | `reflector_run` | load_recent_turns · llm_reflect · append_notes |
| Embedder | `packages/embeddings/src/index.ts embedBatch` | (sub-step) | `embed_batch` step appears under whatever parent called it |

The embedder shows up as a nested `embed_batch` step inside the
parent it was called from (`load_context.embed_query`,
`extract.embed_content_index`, `process_facts.embed_fact_batch`,
etc.). Cache hit / miss / api_call counts land in its `meta`.

Early-exit code paths (no agent enabled, threshold not met,
duplicate node) **don't** create a trace — the system stays quiet
when there's nothing to record. The trace opens at the point we
commit to doing work.

---

## 6. Visual rendering — `/traces/[id]`

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
input / output / meta / error.

No drag, no connect — read-only flowchart. Pan and zoom via
reactflow's built-in controls.

---

## 7. Dashboard widgets — `/debug`

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

## 8. Adding a new trace kind

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

## 9. What we deliberately don't do

- **No auto-prune.** Single-user / single-VPS context; disk is cheap.
  If traces ever hit operational pain we can add a retention job
  pruning rows older than N days.
- **No OTel / Honeycomb export.** One Postgres, one operational story.
- **No streaming view.** Trace pages re-fetch on reload, no SSE.
- **No tracing of read-only Drizzle internals.** Drizzle calls inside
  a `step()` body are captured as part of the parent step's timing,
  not as their own steps. Otherwise every fact-search would produce
  a dozen low-signal rows.
- **No per-fact / per-mention sub-steps inside the extractor.** The
  `reconcile_entities` + `process_facts` steps roll up their loops
  with counts in `output`. A future commit could nest per-iteration
  steps if the visibility is missed.

---

## 10. Reading the code

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
