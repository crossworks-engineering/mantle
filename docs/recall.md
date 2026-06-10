# Recall — "Remy", the memory-recall agent

How Mantle goes *back in time*. The brain's everyday retrieval
(`search_nodes`, the `entity_*` tools) answers "what do I know about X"
cheaply — one vector query over summaries and facts. **Recall** answers a
different question: "take me back to what was *actually said*." It replays the
raw dialogue, losslessly, from a precise point in the past.

Companion docs:
- [`memory.md`](./memory.md) — the six memory layers recall sits beside.
- [`architecture.md` §9b'](./architecture.md#9b-agent-delegation-invoke_agent)
  — the `invoke_agent` delegation machinery Remy rides on.
- [`observability.md`](./observability.md) — every Remy run is its own
  child trace.

---

## 1. The problem

Summaries are lossy. The summarizer rolls old turns into a one-paragraph
[`conversation_digest`](./memory.md#2-the-six-layers) so the responder stays
coherent past its raw-history window without an exploding token bill — but a
digest deliberately *throws away* the actual words. So when the user says:

> "Last week we discussed some topic in the Bible — I can't remember the
> conclusion. Pull up that exact discussion so we can continue."

…the digest can tell you *that* it happened and *roughly* what about, but not
the real exchange. The raw turns are still there (Mantle never prunes them),
just out of the live prompt. Recall is the path back to them.

The key insight (and why this isn't just RAG): a digest is **lossy
compression**; the message archive is **lossless paging**. Recall keeps the old
context out of the hot path but fully queryable, and hands a slice to a live
model that can *reason* over it — not just return chunks.

---

## 2. The flow

Recall is **explicit and pull-based** — it only runs when the user asks to
revisit something. The main assistant (Saskia) recognises the request and
delegates to **Remy**, who locates the window, reads the raw turns, reasons,
and hands back a synthesis.

```
user: "recall last week's Bible discussion + the conclusion"
   │
Saskia (responder/assistant)
   │  invoke_agent('remy', "<the user's recall request>")
   ▼
Remy  (agents-table row, depth 2)
   ├─ find_window("Bible discussion", from?, to?)   → candidate windows  [digests]
   ├─ recall_window(period_start, period_end)        → raw turns          [message archive]
   ├─ (if truncated) re-pull narrower sub-ranges and reason over each
   └─ returns a faithful synthesis: when · topic · the actual conclusion
   ▼
Saskia relays it and continues the conversation
```

Two-stage by design: **finding the window is a search problem** (cheap, over
digests); **reading the slice is a reasoning problem** (a live model over raw
text). Both live in *one* agent so it can iterate — if the first window misses,
Remy widens or shifts and re-pulls. That iteration is why recall is an agent,
not a one-shot worker (see [§4](#4-why-remy-is-an-agent-not-an-ai_worker)).

---

## 3. The two tools

Both are builtins in
[`packages/tools/src/builtins-recall.ts`](../packages/tools/src/builtins-recall.ts),
registered into `BUILTIN_TOOLS` like every other agent tool. Read-only; neither
requires operator confirmation.

### `find_window(topic, from?, to?, limit?)`

Locates **when** a topic was discussed. Embeds `topic`, then does a cosine
search over `conversation-digest` notes — the digests are the **routing
directory**. Optional `from`/`to` (a bare `YYYY-MM-DD`, widened to the whole
day, or a full ISO datetime) keep only digests whose
`[period_start, period_end]` overlaps the rough range.

Returns candidate windows, each: `{ node_id, topic, summary, period_start,
period_end, surface, similarity }`. The caller picks the best and calls
`recall_window` with its dates. The digest shape it reads is written by the
summarizer ([`apps/agent/src/summarizer.ts`](../apps/agent/src/summarizer.ts) —
`data.period_start` / `period_end` / `topic` / `summary`, tagged
`conversation-digest`).

### `recall_window(from, to, surface?, limit?)`

Replays the **actual raw turns** in a date range, chronological and lossless.
Pulls from both conversation surfaces and merges them by timestamp:

| Surface | Table | Time column | Owner scope |
|---|---|---|---|
| `telegram` | `telegram_messages` | `sent_at` | join `telegram_chats.user_id` |
| `web` | `assistant_messages` | `created_at` | `owner_id` directly |

`surface` filters to `telegram` / `web` / `all` (default). Each turn:
`{ surface, direction, speaker, at, text, from? }` — `inbound`→`user`,
`outbound`→`assistant`. `limit` defaults to 200 (max 500); if the window holds
more, the result is flagged `truncated: true` with a note telling the caller to
narrow the range or walk it in sub-ranges rather than trust a partial slice.

The date-range queries are backed by `telegram_messages_chat_sent_idx` /
`telegram_messages_sent_at_idx` and `assistant_messages_owner_created_idx`.

**Pure helpers** `parseWindowBound` and `mergeAndSortTurns` are unit-tested in
[`builtins-recall.test.ts`](../packages/tools/src/builtins-recall.test.ts).

---

## 4. Why Remy is an agent, not an `ai_worker`

Mantle's two-table split is a hard line ([architecture.md
§9d](./architecture.md#9d-ai-workers--provider-adapter-framework)):
`ai_workers` are one-shot transformation jobs (extractor, summarizer, tts, …)
with no tools and no loop; `agents` are reasoners with `tool_slugs` and a tool
loop. Recall needs the loop — call `find_window`, call `recall_window`, reason,
maybe re-pull — so Remy is an **`agents` row**. And it has to be: `invoke_agent`
only ever resolves targets from the `agents` table
([`invoke-agent.ts:66`](../packages/agent-runtime/src/invoke-agent.ts) does
`.from(agents)`), pulling `toolSlugs` / `skillSlugs` / `memoryConfig.delegate_to`
— columns an `ai_worker` doesn't have.

Remy runs at delegation **depth 2** (`MAX_AGENT_DEPTH = 2`,
[`invoke-agent-guards.ts`](../packages/tools/src/invoke-agent-guards.ts)), so it
**cannot sub-delegate** — grandchildren are refused. Big spans are handled by
Remy iterating `recall_window` over sub-ranges itself, not by spawning more
agents. Hence Remy carries no `delegate_to`.

### Remy's configuration

Seeded by [`apps/web/scripts/seed-remy.ts`](../apps/web/scripts/seed-remy.ts)
(`pnpm -C apps/web seed:remy`):

| Field | Value |
|---|---|
| `slug` / `role` | `remy` / `custom` |
| `model` | `anthropic/claude-sonnet-4.6` (`REMY_MODEL` to override) |
| `tool_slugs` | `find_window`, `recall_window`, `search_nodes`, `node_read` |
| `params` | `temperature: 0.2` — recall should be faithful, not creative |
| persona | leads with *when + topic + the actual conclusion*, quotes verbatim, refuses to invent, reports what it searched on a miss |

The seed also appends `remy` to the enabled responder's and assistant's
`memory_config.delegate_to`, so delegation works immediately from both Telegram
and web. (If no dedicated `assistant`-role agent exists, web `/assistant` falls
back to the responder — so the single grant on the responder covers both
surfaces.)

`researcher` is **deliberately reserved** for a future *outward* agent (web /
online research). Remy is the inward, archive-facing counterpart — the
distinction keeps each persona's job crisp.

---

## 5. Observability

Every recall is fully traced for free, via the existing delegation plumbing:
Saskia's turn shows an `invoke_agent` step whose `meta` carries
`child_trace_id` + `child_cost_micro_usd`; Remy gets its own `traces` row
(`kind='manual'`, `subjectKind='child_agent'`, `data.parent_trace_id` set), with
`find_window` / `recall_window` as nested steps. Open `/traces` and pivot from
Saskia's turn into Remy's child trace to see exactly which windows it considered
and which turns it pulled. Costs attribute to Remy's own trace and don't roll up
into the parent, so `/debug` "spend by agent" stays correct.

---

## 6. Honest limits

- **Dialogue first, working-state on demand.** Recall replays the *exchanged*
  turns by default. Pass `recall_window(..., include_traces: true)` to also fold
  in the `traces` for that window — what tools/agents ran and a gist of what they
  returned — recovering the hidden working-state the words alone don't show. (It
  surfaces a compact step-gist per trace, not full payloads; drill into a
  specific trace at `/traces/<id>` for everything.)
- **`find_window` sees only digested conversation.** A chat is only digested
  once it crosses the summarizer threshold, so a *very recent* discussion may
  not have a digest yet. `recall_window` doesn't care — call it directly with a
  rough date range when the timing is known.
- **All channels are digested by ONE summarizer.** Since the unified
  conversation stream (migration 0072 — see [`conversation.md`](./conversation.md)),
  a single `summarize_due` (per-agent, fired on `assistant_messages` INSERT
  from any channel) drives `summarizeAgentConversation`; the old per-surface
  split (`summarize_web_due` / `summarizeWebConversation`) is retired. So
  `find_window` indexes web + Telegram conversation alike.
- **Digests are embedded at insert (2026-06-10).** `find_window`'s cosine
  ranking requires `nodes.embedding`; the summarizer now embeds each digest's
  topic + summary as it writes it (the extractor deliberately skips digests,
  so insert-time is the only embed point — canonical text is `digestEmbedText`
  in `@mantle/embeddings`, shared with the re-embed walk). Digests created
  before the fix have no vector and are invisible to `find_window` — heal
  with `pnpm -C apps/web backfill:digest-embeddings --apply`.
- **Truncation is a signal, not silent.** A window past `limit` returns the
  earliest N turns with `truncated: true`; Remy is prompted to narrow and walk
  sub-ranges rather than answer from a partial slice.

---

## 7. Setup & activation

1. An `openrouter` API key must exist (`/settings/keys`) — the seed resolves it.
2. `pnpm -C apps/web seed:remy` — creates/updates Remy + wires delegation.
   Idempotent.
3. **Restart `apps/agent`** so the new builtin handlers register in the running
   process — `tsx --watch` does not reload workspace packages, so a code change
   to `packages/tools` needs a process restart.

Then exercise it: DM Saskia *"last week we discussed a Bible topic — recall the
exact discussion and the conclusion"* and watch `/traces`.

---

## 8. Files

| Concern | File |
|---|---|
| The two tools + pure helpers | [`packages/tools/src/builtins-recall.ts`](../packages/tools/src/builtins-recall.ts) |
| Helper unit tests | [`packages/tools/src/builtins-recall.test.ts`](../packages/tools/src/builtins-recall.test.ts) |
| Registered into the catalog | [`packages/tools/src/builtins.ts`](../packages/tools/src/builtins.ts) (`RECALL_TOOLS`) |
| Seed Remy + wire delegation | [`apps/web/scripts/seed-remy.ts`](../apps/web/scripts/seed-remy.ts) |
| Delegation bridge (targets `agents`) | [`packages/agent-runtime/src/invoke-agent.ts`](../packages/agent-runtime/src/invoke-agent.ts) |
| Depth guard | [`packages/tools/src/invoke-agent-guards.ts`](../packages/tools/src/invoke-agent-guards.ts) |
| Digest writer (the routing directory) | [`apps/agent/src/summarizer.ts`](../apps/agent/src/summarizer.ts) |
| Message archive schema | [`telegram.ts`](../packages/db/src/schema/telegram.ts), [`assistant-messages.ts`](../packages/db/src/schema/assistant-messages.ts) |

---

## 9. Future work

- ~~Recover working-state~~ — **shipped**: `recall_window(include_traces: true)`
  folds the window's `traces` (tools run + result gists) into the recall.
- ~~Web digests~~ — **shipped**: `summarizeWebConversation` + the
  `summarize_web_due` trigger (migration 0044) digest the web /assistant stream.
- **Dedicated `assistant` agent.** Today web falls back to the responder; give
  `/assistant` its own row if the surfaces need to diverge.
- **Semantic windows.** `find_window` ranks whole digests; chunk-level recall
  (à la `content_chunks`) could pinpoint the exact turn-span within a long
  digest.
