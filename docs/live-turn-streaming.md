# Live turn streaming & status (Phase 1–3)

> ✅ **BUILT & MERGED (v0.78.0).** Web streaming (status + token-by-token reply),
> Stop-on-every-provider, the non-blocking 202 route, the narrator worker, and
> `Last-Event-ID` replay all shipped; the Flutter companion consumer is built +
> unit-tested. This file is now both the **design** and a **status record** (each
> section carries an inline "Implementation status" note). Session record:
> [`live-turn-streaming-handover.md`](./live-turn-streaming-handover.md);
> condensed summary in
> [`architecture.md` §3a.3](./architecture.md#3a-durable-runners-the-febe-split-and-live-turn-streaming).

**Branch:** `feat/live-turn-streaming`
**Status:** ✅ shipped v0.78.0 (was: design — implementation starts after the FE/BE split lands & is audited).
**Goal:** show, live, what an agent is doing during a turn — from a coarse status line
("Searching your brain…") all the way to token-by-token streaming of the reply — and do
it so **both the web client and the Flutter companion** consume the same contract.

---

## 0. The one principle everything hangs off

A turn runs on a **durable DBOS workflow** on `apps/api`. Durability and liveness are two
separate concerns and must travel on two separate paths:

| Concern | Carries | Path | Crash behaviour |
| --- | --- | --- | --- |
| **Correctness** | the final assembled `ChatResult` (text, tool calls, usage) | DBOS journal → `assistant_messages` | exactly-once, survives crash |
| **Liveness (UX)** | a stream of deltas (status, tokens, reasoning) | an **ephemeral** side channel, *around* the journal | allowed to be lost / restarted |

**Rule: never make the journal carry tokens.** Streamed deltas are decoration. The source of
truth for the *answer* is always the DB. If the runner crashes mid-stream we throw the partial
tokens away, DBOS re-runs the step, it re-streams — and the user never loses the answer because
the answer was never *in* the stream. That asymmetry is the whole design.

---

## 0.1 Reconciled with the FE/BE split (2026-06-27)

This plan was written against the pre-split world. The FE/BE split (PR #1, ~v0.66.41 — see
[`docs/fe-be-split-session-handover.md`](fe-be-split-session-handover.md)) changed the transport
substrate. Incorporated here:

- **Web SSE is now `apiEventStream`, not browser `EventSource`** (split item #5,
  [`apps/web/lib/api-fetch.ts`](../apps/web/lib/api-fetch.ts)) — it injects base-URL + bearer and
  bounces to `/login` on 401. The streaming consumer rides this, which makes it Electron/detached-
  ready for free. It already has exponential backoff + jitter and "throwing `onMessage` → `onError`
  (no reconnect storm)."
- **The new `GET /turn/:id/stream` is bearer-auth'd from day one.** The *existing*
  `assistant/turn/stream` is a documented same-origin-only exception (deferred Electron gap, §3.2 of
  the handover — "transport not on the bearer"). Building the new endpoint on the bearer transport
  **closes that gap** rather than inheriting it.
- **`Last-Event-ID` replay is a known-open gap** — `LISTEN/NOTIFY` has no backlog, so `apiEventStream`
  reconnects are best-effort today. The §2 buffer is precisely what closes it; until then we rely on
  durable-row reconciliation (§6) + an optional `refetchInterval`, per the handover's own guidance.
- **Event contract is a typed DTO in `@mantle/client-types` with compile-time drift checks — no
  runtime zod** (matches the split's #3b decision: first-party producers + DTO drift-as-compile-error
  instead of blanket response validation).
- **Endpoint follows the proven route recipe**: `const user = await getOwnerOr401(); if (user
  instanceof Response) return user;` (global `Response`, no `NextResponse` import).
- **⚠️ The in-process `EventEmitter` bus is INVALID — corrected to Postgres `NOTIFY` from day one.**
  An earlier draft of §2 assumed a single instance could bridge the producer and the SSE socket
  with an in-process emitter. It can't: **`apps/api` (the DBOS runner, no HTTP) and `apps/web` (which
  serves every `/api/**` route incl. SSE) are ALWAYS separate processes**, in dev and prod alike. The
  turn executes in `apps/api`; the browser's socket is held by `apps/web`. The FE/BE split *causes*
  this separation rather than removing it. So the bus is Postgres `LISTEN/NOTIFY` (the existing
  `lib/realtime` bridge) from the very first commit — not a scale-out concern. See the corrected §2.

> **Implementation status (Step 0 — done):** the cross-client contract (`TurnEvent` in
> `@mantle/client-types`), the server transport (`@mantle/turn-stream`: `TURN_STREAM_CHANNEL` +
> `publishTurnEvent` via `pg_notify`), the web subscribe side (`subscribeTurnStream` in
> `apps/web/lib/realtime.ts`), and the flagged bearer SSE endpoint
> (`GET /api/assistant/turn/[turnId]/stream`, gated by `MANTLE_TURN_STREAMING`) are built and
> typecheck-clean. No producer is wired, so the surface is dark — zero behaviour change.

---

## 1. The cross-client event contract (the most important section)

The stream is a **versioned, client-agnostic JSON event contract**, not a web detail. Web React
and Flutter are both just subscribers. Every event:

```jsonc
{
  "v": 1,                 // schema version — bump on breaking change
  "turnId": "trn_…",      // the durable turn / outbound message id
  "seq": 42,              // monotonic per-turn sequence (resume cursor)
  "round": 1,             // tool-loop round this belongs to
  "type": "text-delta",   // see below
  "data": { … }           // type-specific payload
}
```

Event `type`s (one stream unifies all three phases):

| type | payload | phase | meaning |
| --- | --- | --- | --- |
| `turn-start` | `{ agentSlug, model }` | 1 | a pending outbound message now exists; attach UI to `turnId` |
| `status` | `{ label, kind }` | 1–2 | "Searching your brain…" — grounded, optionally persona-styled |
| `tool-start` | `{ name, summary }` | 1 | a tool round began |
| `tool-end` | `{ name, ok }` | 1 | tool round finished |
| `reasoning-delta` | `{ text }` | 3 | a chunk of the model's reasoning (raw) |
| `text-delta` | `{ text }` | 3 | a chunk of the visible reply |
| `done` | `{ status: "complete" }` | 1–3 | terminal — client now reconciles against the DB row |
| `error` | `{ status: "failed", message }` | 1–3 | terminal failure |

Design rules that protect both clients:
- **`seq` is the resume cursor.** SSE `id:` field carries it; a reconnecting client sends
  `Last-Event-ID` to resume. Mobile networks drop — this is not optional for the companion.
- **Terminal events are advisory, not authoritative.** On `done`/`error` the client replaces its
  accumulated buffer with the **DB row's** final text (see §6). A client that *missed the whole
  stream* still renders correctly from the DB. Streaming never becomes a correctness dependency.
- **Additive evolution only.** New `type`s and new `data` fields are non-breaking; clients ignore
  unknown `type`s. Breaking changes bump `v`.
- **`TurnEvent` is a DTO in `@mantle/client-types`** (the web client imports it; the Dart companion
  mirrors it from this doc). Server emit sites annotate the return type so a producer↔contract drift
  is a compile error — the split's chosen alternative to runtime response validation.

---

## 2. Transport: SSE over the existing realtime bridge

Use **Server-Sent Events** — unidirectional (server→client is all we need), survives HTTP infra,
trivially parsed by both the web client and Flutter. The web client consumes it through
**`apiEventStream`** ([`apps/web/lib/api-fetch.ts`](../apps/web/lib/api-fetch.ts), split item #5) —
NOT raw browser `EventSource` — so it carries the bearer + base-URL and is detached/Electron-ready.
The endpoint is **bearer-authed from day one** (`getOwnerOr401`), unlike the legacy same-origin-only
`assistant/turn/stream`; see §0.1.

Cross-process delivery (runner executes on one process, the client's socket lives on another)
reuses the existing **Postgres `LISTEN/NOTIFY` bridge** in `lib/realtime` — the same mechanism
behind the `conversation_changed` channel today. Note its current limit: **no backlog**, so a
reconnect can miss deltas — the §2 buffer is what adds `Last-Event-ID` replay on top.

**Two server processes, always.** This is the crux the implementation made concrete: the turn runs
in **`apps/api`** (DBOS runner, no HTTP surface) and the browser's SSE socket is held by **`apps/web`**
(which serves every `/api/**` route). They never share memory — Postgres `NOTIFY` is the bridge.

```
browser / flutter      apps/web (Next, /api/**)          apps/api (DBOS runner)
   │                      │                                  │
   ├─ POST /assistant/turn ─▶ enqueue DBOS workflow ─────────▶ runs the turn (durable)
   │                      │   (today: awaits result;          │
   │                      │    Phase 3: returns turnId)        │   ┌─ workflow ─────────────────┐
   │                      │                                    │   │ LLM step: chatStream()      │
   ├─ GET …/turn/:id/stream ─▶ subscribeTurnStream(owner,turn) │   │  ├─ accumulate full text     │
   │   (SSE via apiEventStream) │      ▲                       │   │  ├─ publishTurnEvent() ──┐   │ ephemeral
   │                      │   LISTEN  │  Postgres NOTIFY        │   │  │   pg_notify('turn_   │   │
   │◀─ status / text-delta ──┤   'turn_stream' ◀───────────────┼───┼──┘   stream', envelope) ┘   │
   │                      │                                    │   │  └─ return ChatResult ─────▶│ DURABLE (journal)
   │◀─ done ──────────────┤   (assistant_messages: pending→complete, fired by DB trigger) │      │
   │                      │                                    │   └────────────────────────────┘
   └─ reconcile reply text against the durable assistant_messages row
```

**The bus, as built (Step 0).** Not a swappable interface with an in-process option — the process
split rules that out. Two concrete halves over one Postgres channel:

```ts
// producer side — @mantle/turn-stream (imported by the apps/api runner)
publishTurnEvent(ownerId: string, event: TurnEvent): Promise<void>  // pg_notify; fire-and-forget, never throws

// consumer side — apps/web/lib/realtime.ts (the SSE route subscribes)
subscribeTurnStream(ownerId, turnId, (event: TurnEvent) => void): Promise<() => void>  // owner-filtered; returns unsubscribe
```

The NOTIFY payload is a `{ ownerId, event }` envelope; `ownerId` is the cross-tenant filter and is
stripped before the event reaches the browser. **`NOTIFY` caps payloads at ~8 KB**, so deltas stay
tiny — long output streams as many small `text-delta`s, never one batched blob.

- **Replay (Step 4, mobile-grade) — ✅ BUILT (v0.77.0):** `NOTIFY` has no backlog, so a reconnect
  can miss deltas. The fix is a short-TTL **buffer** — the `turn_stream_buffer` table keyed by
  `(turn_id, seq)`. `publishTurnEvent` writes each event there (gated on `MANTLE_TURN_STREAMING`,
  `ON CONFLICT DO NOTHING`, lazy TTL sweep on turn-start) in ADDITION to the live `NOTIFY`; on
  reconnect with `Last-Event-ID: <seq>` the SSE route replays `seq > N` from the buffer, then
  live-tails. Gap-free + duplicate-free via `makeReplayMerger` (subscribe-first / drain-backlog /
  dedup-by-seq, in `@mantle/turn-stream`). `apiEventStream` sends the header on reconnect
  (EventSource parity). The durable message row still covers the final answer regardless (§6).

Swapping implementations must not touch the workflow or either client.

---

## 3. Phase 1 — grounded status (cheap, model-free)

Already 80 % built. Today [`turn-stage.ts`](../apps/web/lib/assistant/turn-stage.ts) maps the latest
running `trace_steps.name` → a label via 900 ms polling. Phase 1:

1. **Enrich** `stageLabelForStep()` to read `trace_steps.input` (tool args) → "Searching your brain
   for *Pinnacle SLA*", "Reading note *Q3 plan*", "Delegating to *Researcher*".
2. **Push, don't poll.** Emit `status` / `tool-start` / `tool-end` events onto the bus as steps
   open/close, replacing the 900 ms poll. The web client keeps polling as a fallback until the
   stream is proven.

No model, no schema change, ~1 day. Biggest perceived win per unit effort.

---

## 4. Phase 2 — narrator worker (source vs stylist)

A cheap model makes status conversational — but it is a **stylist, not a source**. The *source* of
truth stays the agent's real activity (tool calls + args, and in Phase 3 its reasoning stream). A
second model that *guesses* what the agent is doing will confabulate ("Looking up the contract"
while the agent actually delegated). So:

- Feed the narrator **only the grounded event** (`tool: search_chunks, args:{q:"SLA"}` or a
  reasoning chunk). Prompt: *"describe this action in ≤6 words, present tense, do not speculate,
  never predict next steps."* That rule kills confabulation.
- Run it on **local Ollama** — free, private (tool args / reasoning stay in-boundary), latency-
  tolerant. Fits the existing worker pattern ([`summarizer.ts`](../apps/agent/src/summarizer.ts) /
  [`extractor.ts`](../apps/agent/src/extractor.ts)).
- **Fire-and-forget, never on the critical path.** If it's slow or errors, the turn and the real
  stream proceed untouched. Tag each `status` with `round`/`seq`; a late narration for round 1 is
  dropped if round 2 already started (no overwrite of fresher truth).

After Phase 3 its job *narrows* to "compress the real `reasoning-delta` stream into one line" — a
summarizer fed by ground truth, emitting `status` events on the same bus. Not a parallel guesser.

> **Implementation status (Step 2 + narrator worker — done):** the narrator is a CONFIGURABLE AI
> worker, not local Ollama. Step 2 reused the `summarizer` worker; it was then promoted to its own
> **`narrator` worker kind** (`044f7b1a`, v0.71.0 — enum migration `0106`, `NarratorParams`, manifest
> entry, the full AI-workers Settings form). Its **system prompt is the user-tunable verbosity dial**
> (terse phrase → sentence → short paragraph; `max_tokens` is the length control). `narrateStatus`
> resolves the `narrator` worker first and falls back to `summarizer` + the built-in concise prompt
> on brains that don't have one (zero regression). A **required baseline worker** ⇒ auto-seeds on fresh
> onboarding AND reaches existing brains on the next upgrade (the reconcile's `requiredOnly` pass). Still
> fire-and-forget, off the turn's critical path, tool
> steps only; "Thinking…" stays plain (no narrator spend). The ground-truth-only / never-predict rule
> above still holds — the narrator only restyles a real status line.

---

## 5. Phase 3 — token streaming

> **Implementation status (Phase 3a — done, v0.72.0):** `chatStream()` ships on the **OpenRouter** adapter
> (the common path; `anthropic/claude-*` via OpenRouter streams through it). It returns the final
> `ChatResult` AND publishes `text-delta`/`reasoning-delta` over the NOTIFY bus via a tracing **delta
> observer** (`emitTurnDelta`, sibling of the step observer); the tool-loop's `dispatchChat` uses it when
> `isTurnStreaming()`. Gated by `MANTLE_TURN_TOKENS`. The web route still blocks on `getResult()` — tokens
> stream independently of that, so the route-flip (§9.3) is deferred to **3c**. **Delegated sub-agents
> stream into the same turn**: child traces inherit the parent `turnId`, the `seq` cursor is per-turn, and a
> new `isStreamRoot` flag keeps reply text on the top-level turn while sub-agent status surfaces in the
> trail. Remaining: **3b** (Anthropic native streaming) + **3c** (status lifecycle + `done`/`error` +
> non-blocking route). The DBOS durability/liveness split (§5b) worked as designed — no new dependency.

### 5a. Adapter: add `chatStream()`
Non-breaking expansion of `ChatDispatcher` (the interface already anticipates this). Each adapter
gains a streaming path that **returns the final `ChatResult` AND publishes deltas**:

- **OpenRouter** ([`openrouter-chat.ts`](../packages/voice/src/adapters/openrouter-chat.ts)): set
  `stream: true`, read SSE; accumulate `choices[0].delta.content` → `text-delta`,
  `delta.reasoning` → `reasoning-delta`. **Tool calls stream as fragments** —
  `delta.tool_calls[].function.arguments` arrives as partial JSON; concatenate per index, parse at
  `finish_reason`. Pass `usage: { include: true }` so the final chunk still carries token counts
  for [`recordChatUsage`](../packages/tracing/src/llm-usage.ts) — otherwise cost tracking breaks.
- **Anthropic** ([`anthropic-chat.ts`](../packages/voice/src/adapters/anthropic-chat.ts)): native
  `messages` streaming; `content_block_delta` text + (if enabled) thinking deltas.
- **Fallback:** keep the one-shot path; any model/provider that won't stream degrades to a single
  `text-delta` + `done`. Both clients render identically.

### 5b. Inside the DBOS step
The streaming happens *inside* a journaled step — DBOS doesn't care what a step does internally,
only what it returns. The publish is a **non-journaled side effect**: safe to partially execute or
skip on crash (exactly what we want for ephemeral tokens). The step's *return value* — the fully
assembled `ChatResult` — is what gets journaled.

---

## 6. Message lifecycle & reconciliation

The reserved `assistant_messages.status` column (`pending | complete | failed`) finally earns its
keep — and it's what lets *any* client re-attach after a drop:

1. **Turn start:** runner inserts the outbound row as `pending`. This gives every client a **stable
   `turnId`** to bind the stream to *before any text exists*.
2. **Streaming:** deltas carry that `turnId` + `seq`.
3. **Done:** row flips to `complete` with the authoritative final text (or `failed`).
4. **Client reconciles:** on `done`/`error`, replace the accumulated partial buffer with the **DB
   row's** text. This makes "partial ≠ final", crash-restart, and missed-stream all invisible.

A client that connects *late* or *missed the stream entirely* just reads the `complete` row via the
existing `conversation_changed` realtime ping — no special case.

---

## 7. Reconnection / resume

- **Best-effort (ship first):** on reconnect, nothing new until the next delta; the final answer is
  always recoverable from the DB. Simplest; consistent with "tokens may be lost." **This is exactly
  where `apiEventStream` is today** — `LISTEN/NOTIFY` has no backlog, so reconnect-gap deltas are
  lost (a documented split gap). Durable-row reconciliation (§6) makes that invisible for the *final
  answer*; pair with `refetchInterval` only on a screen that must not miss an intermediate event.
- **Replayable (mobile-grade) — ✅ BUILT (v0.77.0):** the §2 buffer + `seq`/`Last-Event-ID` lets a
  reconnecting client replay missed deltas from its last cursor — the concrete fix for the documented
  replay gap. The web client exercises it (its `apiEventStream` resends the header on reconnect);
  the companion is the real exercise, since it backgrounds and rides flaky networks.

---

## 8. Mobile companion (Flutter) — first-class, not an afterthought

The contract above is deliberately client-neutral. For the companion
(`~/Projects/mantle-companion`, Flutter + shadcn_ui):

- **Consume SSE in Dart** off the same `GET /turn/:id/stream`. Parse the JSON events from §1; no
  browser-only assumptions (no reliance on `EventSource` quirks — plain `data:`/`id:` framing).
- **Auth = the mobile bearer in the `Authorization` header**, not a cookie. The split hardened this:
  the cookie path now *rejects* kinded tokens (`k:'m'`/`k:'a'`), so the companion's `k:'m'` token
  must ride the header — which is exactly what a bearer SSE endpoint expects. No cookie games.
- **Background/foreground is the hard case.** iOS suspends the app mid-turn → the socket dies. On
  resume: (a) read the durable row (it may already be `complete`), and (b) if still `pending`,
  reopen the stream with `Last-Event-ID` to resume. The §6 lifecycle is precisely what makes this
  clean — the companion never needs the stream to be reliable, only the DB.
- **Push hand-off.** When backgrounded, the existing push relay (`mantle-push`) notifies on turn
  completion — same `turnId` model. Streaming is foreground polish; push covers background. They
  share one identifier and one durable row.
- **Keep-alive parity.** Reuse the 25 s `: ping` keep-alive from the existing companion stream so
  proxies don't reap idle connections on cellular.

**Constraint for every Phase 1–3 PR:** if a change can't be expressed as a JSON event the companion
could also render, it's modelled wrong. The web client must not get a private side door.

---

## 9. Rollout sequence

0. **Contract first — ✅ DONE.** `TurnEvent` (`@mantle/client-types`) + the Postgres-`NOTIFY` bus
   (`@mantle/turn-stream` publish / `subscribeTurnStream` in `lib/realtime`) + the flagged bearer
   `GET /api/assistant/turn/[turnId]/stream` endpoint. No producer wired — zero behaviour change.
1. **Phase 1.** Emit `status`/`tool-*` from the trace tap; enrich labels with args; web consumes
   the stream (poll stays as fallback).
2. **Phase 2.** Narrator worker on local Ollama, fire-and-forget, styling `status` events.
3. **Phase 3.** `chatStream()` on OpenRouter then Anthropic; `text-delta`/`reasoning-delta`; flip
   the web route to return `turnId` + stream instead of awaiting `getResult()`; wire `status`
   reconciliation.
4. **Mobile.** `turn_stream_buffer` + `Last-Event-ID` replay — ✅ DONE (v0.77.0); the web client
   exercises it. REMAINING: the Flutter companion consumes the same endpoint and sends the header on resume.
5. **Scale-out (only if needed).** The `NOTIFY` bus already crosses processes, so no transport swap
   is required — only the buffer (step 4) and the per-process rate limiter remain as scale concerns.

Each step is independently shippable and degrades gracefully to the one before it.

---

## 10. Open decisions

- **Buffer store** when we scale out: `turn_stream_buffer` table (no new infra, fits the
  Postgres-centric stack) vs Redis (purpose-built, another dependency). Lean table-first.
- ~~**Narrator model:**~~ **RESOLVED** — the narrator is its own configurable worker kind; the model is
  a per-owner Settings choice (default: openrouter `gemini-flash-lite`), and its system prompt is the
  verbosity dial. See §4's implementation note.
- **Reasoning exposure:** show `reasoning-delta` to end users (collapsible) or only feed it to the
  narrator? Privacy/UX call — default to narrator-only first.
- **Endpoint home — RESOLVED:** the SSE endpoint lives in **`apps/web`** (all `/api/**` routes do;
  `apps/api` has no HTTP surface). It can't be "co-located with the workflow" — that's exactly why
  the bus is Postgres `NOTIFY` (§2). The producer (`publishTurnEvent`) runs in `apps/api`.
