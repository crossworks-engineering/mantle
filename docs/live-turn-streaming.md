# Live turn streaming & status (Phase 1–3)

**Branch:** `feat/live-turn-streaming`
**Status:** design — implementation starts after the FE/BE split lands & is audited.
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
- **Same scaling boundary as the rate limiter**: the in-process bus is fine until `apps/api` scales
  horizontally — the exact point the handover flags for the per-process rate limiter.

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

```
browser / flutter            apps/api (backend, post-split)
   │                          │
   ├─ POST  /turn ───────────▶ enqueue DBOS workflow → returns { turnId } immediately
   │                          │
   ├─ GET   /turn/:id/stream ─▶ SSE handler: subscribe(bus, turnId), replay from Last-Event-ID
   │   (SSE; Last-Event-ID)    │
   │                          │   ┌─ workflow (durable) ───────────────────────┐
   │◀─ status ────────────────┼───┤ narrator worker / trace tap → publish      │ ephemeral
   │◀─ text-delta ────────────┼───┤ LLM step: chatStream()                     │ ephemeral
   │◀─ text-delta ────────────┼───┤   ├─ accumulate full text                  │
   │                          │   │   └─ return final ChatResult ─────────────▶│ DURABLE (journal)
   │◀─ done ──────────────────┼───┤ flip assistant_messages pending→complete   │
   │                          │   └─────────────────────────────────────────────┘
   │
   └─ reconcile reply text against the durable assistant_messages row
```

**Transport abstraction.** Hide the bus behind a tiny interface so topology never leaks into
feature code:

```ts
interface TurnBus {
  publish(turnId: string, event: TurnEvent): void;          // fire-and-forget, never throws
  subscribe(turnId: string, fromSeq: number,
            onEvent: (e: TurnEvent) => void): () => void;    // returns unsubscribe
}
```

- **Single `apps/api` instance (near-term):** back it with an in-process `EventEmitter`. No new
  infra. The FE/BE split is what makes this possible — workflow + SSE socket now share a process.
- **Multiple replicas (later):** back it with the existing pg `LISTEN/NOTIFY` bridge. Caveat:
  `NOTIFY` payloads cap ~8 KB, so use it as a **wakeup** — write deltas to a short-lived buffer
  (Redis or a `turn_stream_buffer` table keyed by `(turnId, seq)` with TTL) and have the SSE
  handler drain the buffer. The buffer also powers `Last-Event-ID` replay for free.

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

---

## 5. Phase 3 — token streaming

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
- **Replayable (mobile-grade, add when the buffer exists):** the §2 buffer + `seq`/`Last-Event-ID`
  lets a reconnecting client replay missed deltas from its last cursor. This is the concrete fix for
  the documented replay gap. Worth it specifically because the companion backgrounds and rides flaky
  networks.

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

1. **Contract first.** Land the `TurnEvent` types + `TurnBus` interface (in-process impl) + the
   `GET /turn/:id/stream` SSE endpoint, behind a flag. No behaviour change yet.
2. **Phase 1.** Emit `status`/`tool-*` from the trace tap; enrich labels with args; web consumes
   the stream (poll stays as fallback).
3. **Phase 2.** Narrator worker on local Ollama, fire-and-forget, styling `status` events.
4. **Phase 3.** `chatStream()` on OpenRouter then Anthropic; `text-delta`/`reasoning-delta`; flip
   the web route to return `turnId` + stream instead of awaiting `getResult()`; wire `status`
   reconciliation.
5. **Mobile.** Companion consumes the same endpoint; add the replay buffer for resume.
6. **Scale-out (only when needed).** Swap the in-process bus for the pg `NOTIFY` + buffer impl.

Each step is independently shippable and degrades gracefully to the one before it.

---

## 10. Open decisions

- **Buffer store** when we scale out: `turn_stream_buffer` table (no new infra, fits the
  Postgres-centric stack) vs Redis (purpose-built, another dependency). Lean table-first.
- **Narrator model:** which local Ollama model balances latency vs phrasing quality.
- **Reasoning exposure:** show `reasoning-delta` to end users (collapsible) or only feed it to the
  narrator? Privacy/UX call — default to narrator-only first.
- **Endpoint home:** lives on `apps/api` post-split (co-located with the workflow). Pre-split, a
  temporary `apps/web` shim is possible but discouraged — wait for the split per the stated plan.
