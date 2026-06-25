# Research — "Researcher", the web-search agent

The outward-facing twin of [Remy](./recall.md). Where recall goes *inward* into
the user's own conversation archive, the **researcher** goes *outward* to the
live internet: it plans queries, searches, cross-checks, and hands back a cited
synthesis. Saskia delegates to it; Saskia decides whether to keep the result.

Companion docs:
- [`reader.md`](./reader.md) — the page-reader sibling: *finds* pages here, *reads* a given URL there.
- [`recall.md`](./recall.md) — the inward twin (memory recall).
- [`architecture.md` §9b'](./architecture.md#9b-agent-delegation-invoke_agent)
  — the `invoke_agent` delegation path both agents ride on.
- [`email-send.md`](./email-send.md) — the send half of "research X and email it to me".

---

## 1. The flow

```
You → Saskia: "what does the evidence say about drinking olive oil daily?"
   │  trace: responder_turn (Saskia)
   ├─ invoke_agent('researcher', "<focused question>")
   │     └─ child trace: manual / child_agent  (Researcher, depth 2)
   │          ├─ search_nodes(...)   ← optional: do I already know this?  [the brain]
   │          ├─ web_search("…")  → Perplexity Sonar → cited answer  [the live web]
   │          │     (may search several times to triangulate)
   │          └─ synthesises → returns answer + Sources to Saskia
   └─ Saskia relays it; if it's worth keeping, she calls note_create → brain
```

Two layers by design: **`web_search` is the raw primitive** (one search →
a cited answer); **the researcher is the smart layer** that plans, cross-checks,
and synthesises. Saskia is the orchestrator that decides when to delegate and
what to do with the result.

---

## 2. `web_search` — the raw primitive

[`packages/tools/src/builtins-research.ts`](../packages/tools/src/builtins-research.ts).
Asks **Perplexity Sonar via the existing OpenRouter key** (no new provider or
key) and returns a synthesised, cited answer.

| Arg | Required | Notes |
|---|---|---|
| `query` | ✅ | focused natural-language query |
| `recency` | — | `day`/`week`/`month`/`year` — bias toward recent results |

Returns `{ query, model, answer, citations[] }`. Model is
`MANTLE_WEB_SEARCH_MODEL` (default `perplexity/sonar-pro`; swap to
`sonar-reasoning` for harder questions or `sonar-deep-research` for exhaustive
runs). Citation extraction is defensive — reads both Perplexity's top-level
`citations` and OpenRouter's per-message `annotations` (unit-tested via
`extractCitations`). It requests `usage: { include: true }` so the real cost
(incl. Sonar's per-search surcharge) is attributed to the trace — see
[§5](#5-cost--observability).

`web_search` only sees the **public web**. For the user's own stored content,
the researcher uses `search_nodes` / the recall tools instead.

---

## 3. "Researcher" — the agent

Seeded by [`apps/web/scripts/seed-researcher.ts`](../apps/web/scripts/seed-researcher.ts)
(`pnpm -C apps/web seed:researcher`):

| Field | Value |
|---|---|
| `slug` / `role` | `researcher` / `custom` |
| `model` | `anthropic/claude-sonnet-4.6` (`RESEARCHER_MODEL` to override) |
| `tool_slugs` | `web_search`, `search_nodes`, `node_read` |
| `params` | `temperature: 0.3` |
| persona | plan focused queries → cross-check → synthesise → **always cite**; never fabricate URLs/quotes; returns the finished answer, doesn't persist |

Like Remy, the researcher is an **`agents` row, not an `ai_worker`** — recall
that `invoke_agent` only resolves targets from the `agents` table and runs a
tool loop (`invoke-agent.ts`); research needs that loop (search → reason →
search again). It runs at delegation **depth 2** (`MAX_AGENT_DEPTH`), so it
can't sub-delegate. The seed wires `researcher` into the responder's and
assistant's `memory_config.delegate_to`.

---

## 4. Persistence — "Saskia decides"

The researcher **does not save anything** — it returns a synthesis. Saskia (the
orchestrator) decides whether it's worth keeping and, if so, calls
**`note_create`** ([`builtins-notes.ts`](../packages/tools/src/builtins-notes.ts)),
which writes a `note` node. The `nodes` INSERT trigger auto-fires the extractor,
so a kept finding is indexed into the brain (summary + embedding + facts +
entities) and becomes searchable/recallable later. This was a deliberate choice
over auto-saving every run (avoids cluttering the brain with throwaway lookups).

---

## 5. Cost + observability

Every research run is its own child trace (`kind='manual'`,
`subjectKind='child_agent'`), reachable from Saskia's `invoke_agent` step
(`meta.child_trace_id`). The Sonar spend inside `web_search` rolls into that
trace via `captureLlmUsage` — tool handlers can attribute LLM cost since the
cost-tracking fix (see [`memory.md`](./memory.md) / the `LlmUsageSink` in
`@mantle/tracing`). So `/debug` "spend by agent" reflects research cost,
attributed to the researcher (not double-counted into Saskia's turn).

---

## 6. Honest limits

- **Quality is Sonar's quality.** `web_search` returns what Perplexity finds;
  the researcher cross-checks and flags disagreement, but can't verify beyond
  what the web surfaces.
- **No fetch-and-read of arbitrary pages itself.** The Researcher works from
  Sonar's synthesised answer + citation URLs, not by crawling each page. To read
  a specific page in full, Saskia delegates to the [Reader](./reader.md)
  (`web_fetch`) instead — they're split on purpose: find vs. read.
- **`researcher` ≠ `remy`.** Outward (web) vs inward (your archive) — kept as
  distinct personas on purpose so each has one clear job.

---

## 7. Setup

1. An `openrouter` API key at `/settings/keys` (covers chat, embeddings, *and*
   Sonar — all routed through OpenRouter).
2. `pnpm -C apps/web seed:researcher` — creates the agent + wires delegation.
3. **Restart `apps/agent`** so `web_search` registers in the running process.

Then ask Saskia anything that needs the live web and watch `/traces` — her
`responder_turn` with an `invoke_agent` step, and the researcher's child trace
running `web_search`.

---

## 8. Files

| Concern | File |
|---|---|
| `web_search` + citation parsing | [`packages/tools/src/builtins-research.ts`](../packages/tools/src/builtins-research.ts) |
| Citation-parse tests | [`packages/tools/src/builtins-research.test.ts`](../packages/tools/src/builtins-research.test.ts) |
| `note_create` (Saskia's save) | [`packages/tools/src/builtins-notes.ts`](../packages/tools/src/builtins-notes.ts) |
| Seed the agent + delegation | [`apps/web/scripts/seed-researcher.ts`](../apps/web/scripts/seed-researcher.ts) |
| Cost attribution helper | [`packages/tracing/src/llm-usage.ts`](../packages/tracing/src/llm-usage.ts) |
| Delegation bridge | [`packages/agent-runtime/src/invoke-agent.ts`](../packages/agent-runtime/src/invoke-agent.ts) |

---

## 9. Future work

- ~~**`fetch_url`** — read a specific page in full~~ — shipped as the
  [Reader](./reader.md) agent (`web_fetch`), a sibling specialist rather than a
  tool on the Researcher.
- **Auto-save toggle** — a per-agent option to persist every research run as a
  note (vs. the current Saskia-decides default).
- **Dedicated search providers** — the adapter framework could add Exa/Tavily as
  alternative `web_search` backends behind the same tool.
