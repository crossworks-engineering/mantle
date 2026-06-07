# Audit handover — chat cost per question (2026-06-07)

> **For a fresh context.** Jason flagged that "general questions through the
> agent" can run ~$0.80 average per chat. This is the investigation so far,
> the evidence, the root cause, and the proposed fix. **Investigation only —
> no code changed.** Everything below is from the **production** DB
> (`ssh cwe@mcp.crossworks.network`, `mantle_pg`).

## TL;DR

- A plain Q&A (`responder_turn`) averages **$0.089** (p50 $0.076, p90 $0.17,
  max $0.29). It is **not** $0.80 in the typical case.
- The **$0.47–$1.07** turns are **sub-agent delegations** (`trace.kind='manual'`,
  `subject_kind='child_agent'` — e.g. the Pages specialist via `invoke_agent`).
  3 of them in 30 days = 43% of chat spend. These are where "$0.80" comes from.
- **Headline root cause: prompt caching is misfiring.** Across chat LLM calls,
  cache **writes (398K tok, billed 1.25×) exceed cache reads (341K, billed
  0.25×)** — the inverse of a healthy cache. 54% of calls re-write the prefix
  instead of reading it; in long tool loops the growing tool-result context is
  never cached and is re-sent uncached every round.
- 30-day total LLM spend (all kinds): **$3.83**; chat portion **$3.27**.

## How cost is recorded (schema)

- `traces` — one row per turn. Aggregates: `cost_micro_usd` (1e6 = $1, integer),
  `tokens_in`, `tokens_out`, `tokens_cache_read`. `kind` ∈ {`responder_turn`
  (chat), `manual` (delegated/child agent runs), `extractor_run`,
  `summarizer_run`, `reflector_run`, `photo_ingest`, `content_ingest`, …}.
  `subject_kind` for chat = `assistant_message`; for delegations = `child_agent`.
- `trace_steps` — per step; `kind='llm_call'` rows carry the per-call detail in
  **`meta`** (jsonb) with keys: `model`, `tokens_in`, `cache_read`,
  `cache_write`, `tokens_out`, `cost_micro_usd`. (Note snake_case keys.)
- Usage→cost mapping: `packages/tracing/src/llm-usage.ts` (reads
  `cache_read_input_tokens` / `cache_creation_input_tokens` etc., computes
  `cost_micro_usd`; trusts OpenRouter's `usage.cost` when present).

## Evidence (re-runnable)

Run prod SQL via stdin to avoid nested-quote hell:
```bash
ssh cwe@mcp.crossworks.network "docker exec -i mantle_pg psql -U postgres -d postgres -P pager=off" <<'SQL'
<your query>
SQL
```

### 1) Cost by trace kind (14d)
```
kind            |  n   | avg_usd | p90_usd | max_usd | avg_in | avg_out | avg_cache_rd
responder_turn  |  21  | 0.0893  | 0.1683  | 0.2898  | 57369  |   244   |   16234
manual          |   3  | 0.4657  | 0.8984  | 1.0719  | 210683 |  4130   |   68691
extractor_run   | 1310 | 0.0004  | …       | 0.0028  |   867  |   170   |     224
```
Query: `select kind, count(*) n, round(avg(cost_micro_usd)::numeric/1e6,4) avg_usd,
round((percentile_cont(0.9) within group (order by cost_micro_usd))::numeric/1e6,4) p90_usd,
round(max(cost_micro_usd)::numeric/1e6,4) max_usd, round(avg(tokens_in)) avg_in,
round(avg(tokens_out)) avg_out, round(avg(tokens_cache_read)) avg_cache_rd from traces
where started_at > now()-interval '14 days' group by kind order by avg_usd desc nulls last;`

### 2) A single $0.29 responder_turn, per LLM call (trace `86194853-1575-49b0-acde-3d90950f75cd`)
```
call | t_in  | cache_read | cache_write | cost
 0   | 21903 |     0      |   21900     | $0.084   ← miss, writes prefix
 1   | 27512 |     0      |   21900     | $0.100   ← MISS AGAIN, re-writes same prefix
 2   | 27631 |  21900     |    5687     | $0.029   ← finally reads
 3   | 30209 |  21900     |    5687     | $0.037
 4   | 36277 |  27511     |     204     | $0.039
```
The first **two** calls each cache-WRITE the same ~22K prefix (~$0.18 wasted).
Query: `select ordinal, (meta->>'tokens_in')::int t_in, (meta->>'cache_read')::int crd,
(meta->>'cache_write')::int cwr, round((meta->>'cost_micro_usd')::numeric/1e6,4) usd
from trace_steps where trace_id='…' and kind='llm_call' order by ordinal;`

### 3) Systemic, all chat calls (14d)
```
llm_calls=35 | calls_missed_but_wrote=19 (54%) | cache_write=398110 | cache_read=340919 | fresh_input=21948
```
Query: `with c as (select (s.meta->>'cache_read')::int crd,(s.meta->>'cache_write')::int cwr,
(s.meta->>'tokens_in')::int tin from trace_steps s join traces t on t.id=s.trace_id
where s.kind='llm_call' and t.kind='responder_turn' and t.started_at>now()-interval '14 days'
and s.meta ? 'cache_read')
select count(*) llm_calls, sum((crd=0 and cwr>0)::int) missed_but_wrote, sum(cwr) cache_write,
sum(crd) cache_read, sum(tin-crd-cwr) fresh_input from c;`

### 4) The $1.07 child_agent run (trace `22433689-fffe-49b6-a128-435883c70036`) — 11 calls
Input grows **12K → 64K**; `cache_read` pinned at **11873** the whole time →
the accumulated tool-result context is re-sent **uncached** every round (last
calls $0.12–$0.23 each). Confirms cache covers only the static prefix, never the
growing tail.

## Root cause (three compounding factors)

1. **Large fixed context (~22K tok/turn)** before any tool runs: system prompt +
   composed skills + ~68 tool definitions + retrieved context (facts,
   content_hits, chunkHits, relations, digests, identity/lifelog block). See
   `packages/agent-runtime/src/conversation.ts` (`loadConversationContext`) +
   `messages.ts` (`buildChatMessages`).
2. **Multi-step tool loops** (3–11 `llm_call`s/turn), each re-sending the whole,
   growing context. Loop driver: `runToolLoop` (`@mantle/agent-runtime`).
3. **Prompt caching misfires** (the big lever) — see below.

## The caching bug — where to look

Model in use: `anthropic/claude-4.6-sonnet` via **OpenRouter**. The chat adapter
is **`packages/voice/src/adapters/openrouter-chat.ts`** (trace step name
`openrouter-chat_chat`). It supports Anthropic-style `cache_control:
{type:'ephemeral'}` markers:
- `cacheControl.systemPrompt: true` → marks the **last system message**
  (`lastSystemIndex`).
- `cacheControl.lastUserMessage` → marks the **last user message**
  (`lastUserIndex`).
- `anySystemHasMarker()` guards the **Anthropic 4-breakpoint cap** (recent
  commits 36749d4 / d4f841c / 2eafc1c were tuning exactly this).

Two observed failures to fix:
- **(a) Double-write on calls 0–1:** call 1 should READ call 0's cached prefix
  but re-writes it. Likely the breakpoint isn't on a *stable* prefix that's
  identical across the first two requests (marker position shifts once the
  assistant tool-call + tool-result messages are appended), so Anthropic doesn't
  match the prior cache. **Fix direction:** pin one ephemeral breakpoint right
  after the static system+tools prefix and keep it byte-identical every round.
- **(b) Growing tail never cached:** in a loop the context grows (12K→64K) but
  only the ~12–22K prefix is cached. **Fix direction:** add ONE *moving*
  breakpoint at the last message each round (within the 4-cap) so round N+1 reads
  everything-so-far, not just the static head.

**Find the caller** that sets `cacheControl` per round (search `cacheControl`
in `packages/agent-runtime` + how `runToolLoop` calls the adapter each
iteration) — the placement decision likely lives there, not only in the adapter.

## Proposed fix + verification

- Adjust cache_control breakpoint placement in `openrouter-chat.ts` (and mirror
  in `anthropic-chat.ts`): a **stable head breakpoint** + a **moving tail
  breakpoint**, staying ≤4 markers. This is the **hot chat path** — Jason wanted
  an explicit go-ahead before touching it.
- **Estimated savings: ~40–60%** of chat cost (cache_write 398K → mostly reads
  at 1/12.5 the price).
- **Verify**: after the change, re-run query #2/#3 on the next few real turns —
  expect `cache_read` to dominate `cache_write`, and `missed_but_wrote` → ~0
  (only call 0 of a turn should miss). Compare avg `responder_turn` cost before
  ($0.089) vs after.
- **Secondary levers** (optional): trim the always-on ~68-tool floor (large fixed
  token cost; see `DEFAULT_ASSISTANT_TOOL_SLUGS` / tool groups); have specialists
  run shorter loops; cap retrieval sizes (`memory_config` limits in
  `conversation.ts`: `content_hit_limit=5`, `chunk_limit=3`, `fact_limit=10`,
  `history_limit=20`).

## Caveats
- Pricing math checks out (cache_write ≈ 1.25× input, cache_read ≈ 0.25×, sonnet
  ~$3/Mtok in) — `cost_micro_usd` is correct; the spend is real, not a
  mis-computation.
- Low sample size on prod (21 responder_turns / 3 delegations in 30d). The
  *pattern* (54% miss-and-rewrite) is consistent across every turn inspected.

## Second-pass verification (2026-06-07, independent re-audit)

A fresh-context pass re-ran every query against prod and read the adapter
code. **All raw numbers reproduce exactly** (responder_turn avg $0.0893,
delegation avg $0.4657 / max $1.07, chat total $3.27, model
`claude-4.6-sonnet-20260217`). But the *diagnosis above is mis-framed* —
three corrections, and the fix is narrower (and OpenRouter-only) than stated.

**Correction 1 — "54% miss / inverse cache" is misleading.** Of 19
miss-and-wrote calls, **17 are the legitimate first call of a turn** (the
first call MUST write the prefix — there is nothing to read yet; not a bug).
Only **2 of 35 calls** are genuine mid-loop re-writes. And `cache_write >
cache_read` globally is explained by **11 of 17 turns being single-call**
one-shot Q&A (no second call ⇒ no read possible), not by a misfire. Split that
proves it:
```
window        | llm_calls | first_call_warming | BUG_midloop_rewrite
all (post-fix)|    35     |        17          |         2
```
Post the 06-06 cap-fix, plain-chat caching is largely **healthy**: in
multi-call turns later calls read the prefix (avg later call $0.032 vs
first-call $0.076).

**Correction 2 — the data is 2 days old, not 14–30.** Every analyzed trace
ran 06-06→06-07, straddling/after the cap-fix (`36749d4`, 06-06 12:47, which
IS deployed on prod `8fd6ec7`). The `interval '14 days'` framing makes a
2-day, 21-turn sample read like a month of evidence.

**Correction 3 — "40–60% savings" applies to delegations, not plain Q&A.**
Two regimes are blended:
- *Plain Q&A ($0.089)* is dominated by the **irreducible ~20K fixed prefix**
  (system + ~68 tool defs + retrieval) written once per turn — caching cannot
  reduce a first write. Breakpoint surgery saves ~5% here. The real lever is
  shrinking that prefix (the "secondary/optional" levers — should be primary
  for this regime).
- *Delegations / long loops ($0.47–1.07)* are where finding (b) bites and
  where 40–60% is real. **Confirmed empirically** on the $1.07 trace
  `22433689`: `cache_read` pinned at **11873 across all 11 calls** while
  `tokens_in` grows 11.9K → 63.6K — the ~52K accumulating tool-result tail is
  re-sent uncached every round (late calls $0.12–$0.23 each).

**Mechanism (and correction to the proposed fix).** The code ALREADY passes
`lastUserMessage: true` every iteration (`tool-loop.ts:276`). The bug is NOT a
missing marker — it is that `lastUserIndex` (`openrouter-chat.ts`) matches only
`role==='user'`, while OpenRouter keeps tool results as `role:'tool'` (OpenAI
shape). So the "moving" marker pins to the original question and never advances
past the tool-result tail. **`anthropic-chat.ts` is already correct** — it
coalesces `tool` → a synthetic user/tool_result message and marks the trailing
block (see its audit-#4 safety-net test), so the marker advances there. The
doc's "mirror in anthropic-chat.ts" is therefore unnecessary.

**Scope — does it affect other providers?** No. Only **openrouter-chat.ts**
(the prod Anthropic-via-OpenRouter path). `anthropic-chat.ts` (direct) is
correct; `deepseek-chat.ts` ignores `cacheControl`; `openai-compat.ts`
(xAI/local) doesn't use Anthropic-style ephemeral breakpoints. Anthropic
(verified via docs) allows `cache_control` on `tool_result` blocks and on the
last message, ≤4 breakpoints, with a 20-block-lookback incremental cache — so
marking the genuine last message each round is both valid and what creates the
advancing write chain the lookback needs.

**The fix (implemented):** in `openrouter-chat.ts`, target the marker at the
last **user-or-tool** message (the genuine tail), emitting `cache_control` on
the tool message's text block when the tail is a tool result. One stable head
(system) + one moving tail = 2 breakpoints, within the 4-cap. Expect the
delegation/long-loop turns to drop ~40–60%; plain single-call Q&A is unchanged
(its cost is the irreducible prefix). Verify with query #4 on the next few
delegations: `cache_read` should climb with `tokens_in` instead of pinning.

## Session context (where the tree is)
- All this session's Pages work is on `origin/main` @ `8fd6ec7` (v0.20.33),
  **deployed to prod**. One later fix — `175d490` (v0.20.34, "show uncommitted
  draft in list preview") — is **merged to local main but NOT pushed/deployed**.
- No code touched for this audit.
