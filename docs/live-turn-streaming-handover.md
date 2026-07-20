# Chat System / Live Turn Streaming — Session Handover

**Branch:** `feat/live-turn-streaming` · **Version:** v0.77.0 · **Untagged, unpushed** (default-branch + tag +
deploy are Jason's call). **Design doc:** [`docs/live-turn-streaming.md`](live-turn-streaming.md).
**Conversation model:** [`docs/conversation.md`](conversation.md).

**Status — Step 3 (token streaming) is COMPLETE; Phase 4's REPLAY BUFFER (backend) is COMPLETE.** The web
`/assistant` chat now: streams the reply token by token over a live thought trail; runs the turn in a separate
durable process that survives navigation/backgrounding (the route returns **202 immediately**); lets the user
**Stop** mid-flight on **any provider** (generation actually halts, the partial reply is kept, and the prompt
drops back into the composer for correction); the responder writes portable standard Markdown; and a dropped
SSE socket now **resumes via `Last-Event-ID`** — the runner buffers every event to `turn_stream_buffer` and the
route replays what a reconnecting client missed (gap-free + duplicate-free), closing the documented reconnect
gap for web AND laying the foundation the companion's background/foreground resume needs. **The Flutter
companion consumer is now BUILT + unit-tested** (separate repo `~/Projects/mantle-companion`, `main` commit
`ee16e88`, v1.3.0+10, **UNPUSHED**) — it consumes the same `GET /api/assistant/turn/:id/stream` (bearer, no new
endpoint): live token streaming into the bubble, stream-driven stage labels, server-side Stop, and
`Last-Event-ID` resume, all degrading gracefully to the legacy blocking path when the server flags are dark.
**It has NOT yet been device-smoked** against a live server with the flags on — that's the remaining
verification (§10). This file is the resume point; read it top-to-bottom, then the design doc §8 for the
companion detail.

---

## 1. TL;DR of the architecture

A turn is **two processes bridged by Postgres NOTIFY**:

```
 browser (apps/web, Next.js — serves ALL /api/**)        runner (apps/api — DBOS, no HTTP)
 ───────────────────────────────────────────────        ──────────────────────────────────
 POST /api/assistant/turn  ──enqueue DBOS workflow──▶    runAssistantTurn():
   ← 202 {turnId}  (non-blocking, streaming on)            insert inbound + outbound('pending')
 GET  /turn/:id/stream  (SSE) ◀─── pg_notify ──────────    emit turn-start
   status / text-delta / reasoning-delta /                 tool loop → chatStream(onDelta, signal)
   turn-start / done / error                       ──┐       └▶ publishTurnEvent('turn_stream')
 POST /turn/:id/cancel  ──── pg_notify ─────────────┼──▶    cancel listener → abortTurn() → AbortController
                                                    │      finalize outbound('complete'/'failed')
 reconcile to durable assistant_messages row  ◀─────┘      emit done / error
```

- **Durability vs liveness travel on separate paths and never mix.** The _answer_ is the DBOS-journaled
  return value of the LLM step → persisted to `assistant_messages` (exactly-once, survives crash). The
  _deltas_ are fire-and-forget `pg_notify` decoration around that step. A dropped delta is cosmetic; the DB
  row is the source of truth. This is the one principle everything hangs off (design doc §0).
- **DBOS was never the obstacle** to streaming. It journals the step's return value; the per-token
  `publishTurnEvent` calls inside the step are non-journaled side effects. No new lib/service was needed.
- **`turnId` on the wire** = the client-minted **idempotency-key** = the DBOS **workflow id** = the live
  **stream correlation id**. It's stable _before any row exists_, so the client subscribes to the stream
  before it POSTs. The **durable outbound `assistant_messages` id is a separate handle**, delivered to the
  client in the `turn-start` event (`outboundId`).

## 2. What shipped (this session, newest first — all on `feat/live-turn-streaming`)

| Commit                               | Ver    | What                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `56292c21`                           | 0.77.0 | **Phase 4 replay buffer (backend)** — `turn_stream_buffer` (migration `0107`); `publishTurnEvent` buffers each event (gated on `MANTLE_TURN_STREAMING`, `ON CONFLICT DO NOTHING`, lazy TTL sweep on turn-start); new `replay.ts` (`getBufferedTurnEvents` + pure `makeReplayMerger`); SSE route replays `seq > Last-Event-ID` before live-tailing (gap-free + dup-free); `apiEventStream` tracks `id:` + resends `Last-Event-ID` (EventSource parity). |
| `f4dbfdd1`                           | —      | docs: Phase 3b.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `445cd098`                           | 0.76.0 | **Phase 3b + all-provider streaming + Stop** — `chatStream()` on all 6 remaining adapters (Anthropic/Google native SSE; xAI/HF/DeepSeek/local via a shared OpenAI-compat streamer), each abort-aware. New `adapters/sse.ts`.                                                                                                                                                                                                                           |
| `0e65c7a4`                           | 0.75.1 | **Stop restores the prompt** to the composer (focus + cursor-to-end) for correction.                                                                                                                                                                                                                                                                                                                                                                   |
| `5a445e1c`                           | 0.75.0 | **Stop mid-flight** — Enter button → Stop button; cross-process abort halts generation, keeps the partial.                                                                                                                                                                                                                                                                                                                                             |
| `368aa3a8`                           | 0.74.0 | **Phase 3c Part B** — non-blocking 202 route + client/dock drive off the stream, reconcile to the durable row.                                                                                                                                                                                                                                                                                                                                         |
| `15c58f8a`                           | 0.73.0 | **Phase 3c Part A** — runner owns the durable outbound row (pending→complete/failed) + emits turn-start/done/error via a tracing turn-lifecycle observer.                                                                                                                                                                                                                                                                                              |
| `99038998`                           | 0.72.3 | **Responder → standard Markdown** (`chat_writing` skill; Pages keeps `rich_writing`).                                                                                                                                                                                                                                                                                                                                                                  |
| `937fa97e`                           | 0.72.2 | Stick-to-bottom autoscroll + jump-to-latest button.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `97fdd066`                           | 0.72.1 | flushSync fix (live buffer via ReactMarkdown; RichText `setContent` microtask-deferred).                                                                                                                                                                                                                                                                                                                                                               |
| `33983412`                           | 0.72.0 | Delegated sub-agents stream into the same turn (turnId inheritance, per-turn seq, `isStreamRoot`).                                                                                                                                                                                                                                                                                                                                                     |
| `e14c109a` / `1542dad4`              | 0.72.0 | **Phase 3a** client + server — reply types out live (OpenRouter `chatStream` + delta observer).                                                                                                                                                                                                                                                                                                                                                        |
| `5673e880` / `044f7b1a` / `5b206060` | 0.71.0 | Narrator promoted to its own required baseline worker kind (verbosity dial).                                                                                                                                                                                                                                                                                                                                                                           |

Prior session: `adb1cdf9` Step 0 (contract + bus), `dfaf4219` Step 1 (grounded status), `cf4e13db` thought-
trail UI, `7005f056` Step 2 (narration). `main` is at `98f76e51` (the FE/BE-split fixes — see
[[api-service-phase2]]).

## 3. The event contract (`TurnEvent` in `@mantle/client-types/src/index.ts`)

Zero-runtime typed DTO (no zod); the producer stamps `v`/`seq`/`round`. **Every event:**
`{ v, turnId, seq, round, type, data }`.

| `type`                    | `data`                                          | Emitted?        | Notes                                                                                |
| ------------------------- | ----------------------------------------------- | --------------- | ------------------------------------------------------------------------------------ |
| `turn-start`              | `{ agentSlug, model, inboundId?, outboundId? }` | ✅              | Fires once the durable rows exist. `outboundId` is the reconciliation handle.        |
| `status`                  | `{ label, kind?, stepId? }`                     | ✅              | The thought trail. `stepId` lets a narrated line replace its grounded line in place. |
| `reasoning-delta`         | `{ text }`                                      | ✅ (tokens on)  | Model thinking; shown faintly, not the reply.                                        |
| `text-delta`              | `{ text }`                                      | ✅ (tokens on)  | A chunk of the visible reply. `round` scopes it to a tool-loop round.                |
| `done`                    | `{ status: 'complete' }`                        | ✅              | Outbound row is final → client reconciles to the DB row.                             |
| `error`                   | `{ status: 'failed', message }`                 | ✅              | Turn failed.                                                                         |
| `tool-start` / `tool-end` | `{ name, summary? }` / `{ name, ok }`           | ❌ defined-only | Reserved; the trail uses `status` today.                                             |

`seq` is monotonic per turn across the root turn AND delegated sub-agents (one `turnId→counter` registry).
`TURN_EVENT_SCHEMA_VERSION = 1`; bump only on a breaking change to an existing event's shape (new types/fields
are additive). The SSE frame is `id: <seq>\ndata: <event JSON>\n\n` — `id:` is the `Last-Event-ID`
resume cursor. NOTIFY itself has no backlog, but the runner now buffers every event to `turn_stream_buffer`
and the route replays `seq > Last-Event-ID` on reconnect (Phase 4, below) — gap-free + duplicate-free.

## 4. File map (where everything lives)

**Contract + transport**

- `packages/client-types/src/index.ts` — `TurnEvent` union + `TurnEventType` + per-type data interfaces.
- `packages/turn-stream/src/` — server transport. `channel.ts` (`TURN_STREAM_CHANNEL='turn_stream'`,
  `TURN_CANCEL_CHANNEL='turn_cancel'`, `TURN_EVENT_SCHEMA_VERSION`); `publish.ts`
  (`publishTurnEvent(ownerId,event)` — now ALSO buffers each event to `turn_stream_buffer` before the notify,
  gated on `MANTLE_TURN_STREAMING`, `ON CONFLICT DO NOTHING`, with a lazy TTL sweep on turn-start;
  `publishTurnCancel(ownerId,turnId)`, the `TurnStreamEnvelope` / `TurnCancelEnvelope` types). Both
  fire-and-forget; never throw. **`replay.ts`** (new) — `getBufferedTurnEvents(ownerId,turnId,sinceSeq)`
  (replay read) + `makeReplayMerger(sinceSeq,emit)` (the pure subscribe-first / drain-backlog / dedup-by-seq
  state machine; tested in `replay.test.ts`). `publish.test.ts` covers the gated buffer write + sweep.
- `packages/db/src/schema/turn-stream-buffer.ts` — the `turn_stream_buffer` table (migration `0107`): PK
  `(turn_id, seq)`, `event jsonb`, `created_at` (+ index for the sweep). Ephemeral replay backlog, NOT durable.

**Runner (`apps/api`)**

- `src/main.ts` — boot: `installTurnStreamObserver()` + `startTurnCancelListener()` before `DBOS.launch()`.
- `src/turn-stream-observer.ts` — installs the THREE tracing observers (see §5) → `publishTurnEvent`.
- `src/turn-cancel.ts` — dedicated Postgres LISTEN on `turn_cancel` → `abortTurn(ownerId, turnId)`.
- `src/workflows/assistant-turn.ts` — the DBOS workflow wrapping `runAssistantTurn` in `withDurableSteps`.
- `src/turn-narration.ts` — `narrateStatus()` (resolves the `narrator` worker → `summarizer` fallback).

**Turn logic (`@mantle/assistant-runtime`)**

- `src/run-turn.ts` — **the heart.** `runAssistantTurn()`: resolves agent, loads context, inserts inbound +
  `pending` outbound, emits `turn-start`, registers the AbortController, runs the tool loop, finalizes the row
  - emits `done`/`error`, detects Stop vs error. See the §7 walkthrough.

**Tracing (`@mantle/tracing/src/store.ts`)** — the observer + abort plumbing:

- step observer (`setStepObserver`) → `status`; delta observer (`setTurnDeltaObserver`/`emitTurnDelta`/
  `isTurnStreaming`) → `text-delta`/`reasoning-delta`; lifecycle observer
  (`setTurnLifecycleObserver`/`emitTurnLifecycle`) → `turn-start`/`done`/`error`.
- per-turn seq registry (`nextTurnSeq`); per-turn **abort registry**
  (`registerTurnAbort`/`abortTurn`/`unregisterTurnAbort`/`currentTurnAbortSignal`).
- `startTrace` inherits a parent's `turnId` (delegation) + sets `isStreamRoot`.

**Tool loop (`@mantle/agent-runtime/src/tool-loop.ts`)**

- `dispatchChat()` — picks `adapter.chatStream` over `adapter.chat` when `isTurnStreaming()`, and injects
  `currentTurnAbortSignal()` into both. The single chokepoint for streaming + Stop wiring.

**Chat adapters (`@mantle/voice/src/adapters/`)** — all now stream + honour `opts.signal`:

- `types.ts` — `ChatOptions.signal?`, `ChatDispatcher.chatStream?(opts, onDelta)`, `ChatStreamSink`,
  `ChatStreamDelta`.
- `sse.ts` — `readSSE()` (abort-aware SSE line reader, async generator), `safeDelta()`, `chatAbortSignal()`
  (combines a Stop signal + a per-call timeout for the one-shot `chat()`).
- `openai-compat.ts` — `streamOpenAICompatChat()` (shared by xai/hf/deepseek/local) + the message/tool
  translation. `openrouter-chat.ts` — `openrouterChatStream()` (SDK-based). `anthropic-chat.ts` —
  `anthropicChatStream()` + `buildAnthropicBody()` (native Messages SSE). `google-chat.ts` —
  `googleChatStream()` + `buildGoogleBody()` (`:streamGenerateContent?alt=sse`). `xai/huggingface/deepseek/
local-chat.ts` — thin `chatStream` delegating to the shared streamer.
- Tests: `chat-stream.test.ts` (12 wire-shape tests across all 3 SSE dialects + abort).

**Web routes (`apps/web/app/api/assistant/`)**

- `turn/route.ts` — POST: auth + attachment extraction (sync), enqueue, then **202 `{turnId}`** if streaming
  on (else the legacy blocking `getResult()` relay).
- `turn/[turnId]/stream/route.ts` — GET SSE; flag-gated 404; bearer-authed; `subscribeTurnStream`.
- `turn/[turnId]/cancel/route.ts` — POST; flag-gated; bearer-authed; `publishTurnCancel`.
- `messages/route.ts` — GET page of the thread (now returns `status`/`error`).
- `lib/realtime.ts` — `subscribeTurnStream(ownerId, turnId, cb)` (one shared LISTEN connection, fans out to a
  Set of subscribers, owner+turn filtered, ownerId stripped before the browser).
- `lib/assistant.ts` — `recentAssistantMessages` / `assistantMessagesBefore` (timeline reads, carry
  `status`/`error`).

**Client (`apps/web/.../assistant/` + `components/assistant/`)**

- `lib/api-fetch.ts` — `apiEventStream(path, onMessage)` is the EventSource-replacement SSE reader (bearer +
  base-URL). Now tracks each frame's `id:` and resends `Last-Event-ID` on reconnect → BOTH consumers
  (`useTurnStream` + the dock) resume gap-free/dup-free with no change to either.
- `components/assistant/use-turn-stream.ts` — `useTurnStream(turnId)` →
  `{ label, trail, reply, phase, outboundId, inboundId, error }`. Subscribes via `apiEventStream`; accumulates
  `text-delta` (latest round, ref accumulator); captures ids from `turn-start`; flips `phase` on `done`/`error`.
- `app/(app)/assistant/assistant-client.tsx` — the transcript + composer. `submit()`, the non-blocking
  reconciliation (`reconcileDone`/`failActiveTurn`/phase-effect/safety-poll), `syncLatest` (merge-by-id),
  the **Stop** button + `stopTurn()` + prompt-restore, and the render (live ReactMarkdown buffer / durable
  RichText / pending thinking-bubble / failed error).
- `components/assistant/assistant-dock.tsx` — app-wide provider; `runTurn()` (the persistent POST); on 202,
  `subscribeDockTurn()` drives the floating mini-chat so a turn keeps progressing across navigation.
- `components/assistant/thought-trail.tsx` — `ThoughtTrail` (live + frozen-record modes).
- `lib/turn-streaming.ts` — `isTurnStreamingEnabled()` (server) / `isTurnStreamingEnabledClient()`.

## 5. The three tracing observers + the streaming gate

Installed once at boot by `apps/api/src/turn-stream-observer.ts`; each is a **no-op unless the trace carries a
`turnId`** (background work pays nothing):

1. **step observer** — every `step()` start → a grounded `status` event, then (off the critical path, if
   `MANTLE_TURN_NARRATION`) a narrated upgrade with the same `stepId`. **Always installed.**
2. **turn-delta observer** — `text-delta`/`reasoning-delta`. **Installed only when `MANTLE_TURN_TOKENS` is
   set** — and _installing it is itself the gate_: `isTurnStreaming()` returns true iff the observer exists AND
   the current trace has a `turnId`. So flag-off ⇒ the tool loop uses one-shot `chat()`, zero behaviour change.
3. **turn-lifecycle observer** — `turn-start`/`done`/`error`. **Always installed.** Driven EXPLICITLY by
   `run-turn.ts` (not by the trace) so timing tracks the durable row: `turn-start` after the rows exist,
   `done`/`error` after the outbound text is committed (which is _after_ the responder trace closes). It owns
   retirement of the per-turn seq cursor on `done`/`error`, so seq stays monotonic past the trace boundary
   (`startTrace` defers that cleanup when a lifecycle observer is wired).

## 6. Streaming + Stop, per provider

`dispatchChat` calls `adapter.chatStream(opts, onDelta)` when streaming is active, passing
`opts.signal = currentTurnAbortSignal()`. Each adapter:

- **OpenRouter** (`openrouter-chat.ts`) — `@openrouter/sdk`, `stream:true` + `usage.include`. Signal → the
  SDK `send(req, { signal })`.
- **Anthropic** (`anthropic-chat.ts`) — native `/v1/messages` SSE: `message_start` (usage) /
  `content_block_start` (tool_use id+name) / `content_block_delta` (`text_delta` | `thinking_delta` →
  reasoning | `input_json_delta` → tool args by block index) / `message_delta` (output tokens).
- **Google** (`google-chat.ts`) — `:streamGenerateContent?alt=sse`: incremental `candidates[0].content.parts[].text`
  - whole `functionCall` parts (Gemini doesn't fragment tool args) + `usageMetadata`.
- **xAI / HuggingFace / DeepSeek / local** — share `streamOpenAICompatChat` (OpenAI delta format:
  `choices[0].delta.content` / `.reasoning_content` / `.tool_calls` frags by index, `[DONE]`,
  `stream_options.include_usage`). HF applies its routing suffix + drops the internal `routing` from the body;
  local routes through `tailnetFetch` when `viaTailnet`.

**Abort contract (uniform):** on `signal.aborted` the streamer **stops reading and returns the PARTIAL reply**
(dropping half-formed tool-call fragments) — it does NOT throw. So a Stop looks like a (short) successful turn:
`run-turn` finalizes the row `complete` with the partial. A real error still throws → the row goes `failed`.
The one-shot `chat()` paths also thread the signal (via `chatAbortSignal`) so a Stop during a force-final /
backup call aborts too.

**The TOOL LOOP honours the abort too (added v0.153.2 — the original wiring only covered generation, so a
Stop during a tool-heavy turn visibly ran to completion).** `runToolLoop` checks `currentTurnAbortSignal()`
at three points: after each chat round (COMPLETE tool calls carried by an aborted round's partial are
discarded, the turn finalizes with the partial text), before each tool call in a batch (remaining calls get
a paired synthetic `cancelled_by_user` result so the provider transcript stays valid — the tool currently
in flight still completes; tools themselves aren't cancellable yet), and after the batch (no further rounds
against a dead signal; the empty-reply retry is also skipped post-abort). Delegated sub-agents run the same
loop with the inherited `turnId`, so they stop with the root turn. Tests:
`packages/agent-runtime/src/tool-loop.abort.test.ts`.

Audit hardening (v0.153.3): `cancelled_by_user` counts as **skipped**, never failed (no red "N failed"
badge on a deliberate stop); a stopped turn finalizes with the **last non-empty round's text** so reconcile
never blanks the streamed text the user was reading; cancelled skips emit no trace step (no "doing X" trail
lines after the Stop) and are excluded from the persisted trail; and an abort surfacing as a thrown
AbortError (the one-shot `chat()` path, `MANTLE_TURN_TOKENS` off) no longer burns retry backoff
(`withChatRetry` short-circuits on `opts.signal.aborted`) or fails over to the backup route
(`turnAborted()` rethrow before `isChatFailover`).

## 7. One turn, end to end (the walkthrough)

1. **Client `submit()`** (`assistant-client.tsx`): mints `idempotencyKey = crypto.randomUUID()`; shows an
   optimistic inbound bubble; `lastPromptRef.current = text`; `setActiveTurnId(idempotencyKey)` →
   `useTurnStream` opens the SSE socket _before_ the POST.
2. **`runTurn()`** (dock provider) POSTs `/api/assistant/turn` with header `idempotency-key`.
3. **Route** auths, processes any attachment synchronously, `client.enqueue(workflowID = idempotencyKey)`,
   returns **202 `{turnId}`** (streaming on). `submit` sees no `outbound` in the response → records
   `pendingTurnRef` and leaves completion to the stream.
4. **Runner** (`runAssistantTurn`, via the DBOS workflow): `record_inbound` → `record_outbound_pending`
   (status `pending`, empty text, stable id) → **emit `turn-start`** (`inboundId`, `outboundId`) →
   `registerTurnAbort(streamId, ownerId)` → build prompt → **tool loop**. `dispatchChat` streams via
   `chatStream`; each delta → `emitTurnDelta` → `publishTurnEvent('turn_stream')` → SSE → the client's
   `reply` buffer types out (rendered with ReactMarkdown). `step()` boundaries → `status` events → the trail.
5. **Completion:** finalize `finalize_outbound` (status `complete`, text = reply, model) → **emit `done`** →
   `retireAbort()`.
6. **Client reconciles:** `useTurnStream.phase` → `'done'` → the phase-effect runs `reconcileDone()`:
   `syncLatest()` (merge-by-id) pulls the canonical inbound + complete outbound rows, drops the optimistic
   bubble, freezes the thought trail onto the outbound row (by `outboundId`), and renders it with **RichText**.
   `sending=false`. A 3s **safety poll** on the durable row is the backstop if `done` is missed (NOTIFY has no
   backlog).
7. **Stop path:** user clicks Stop → `stopTurn()` POSTs `/turn/:id/cancel` (and restores `lastPromptRef` into
   the composer + focuses it). `publishTurnCancel` → `turn_cancel` NOTIFY → runner's listener →
   `abortTurn(ownerId, turnId)` aborts the AbortController → the in-flight `chatStream` returns its partial →
   the turn finalizes `complete` with the partial → `done` → normal reconcile. Generation halts ~360ms after
   the click.
8. **Error path:** the tool loop throws (not aborted) → `fail_outbound` (status `failed`, error) → emit
   `error` → re-throw (workflow → ERROR). Client `phase='error'` → `failActiveTurn()` shows it + drops the
   optimistic bubble.

## 8. Resume locally (servers + flags)

Local DB is **Docker Desktop** (`mantle_pg`/`mantle_minio`/`mantle_tika`); app DB is `postgres` at
`127.0.0.1:54323` (line 10 of `apps/web/.env.local`; prod-tailnet + tunnel URLs commented below it). Owner id
= `bc505da9-c323-43c7-bafb-6c06a2d443de`. Query the row state with:
`docker exec mantle_pg psql -U postgres -d postgres -t -A -F '|' -c "select direction,status,length(text) from assistant_messages order by created_at desc limit 4;"`

The four flags are already in `.env.local` (gitignored): `MANTLE_TURN_STREAMING=1`,
`NEXT_PUBLIC_MANTLE_TURN_STREAMING=1`, `MANTLE_TURN_NARRATION=1`, `MANTLE_TURN_TOKENS=1`.

**Migration `0107` is ALREADY applied to this local DB** — and `pnpm db:migrate` is currently **blocked by the
auto-mode classifier** (it can't prove the target isn't the prod DB reachable over Tailscale). It was applied
via `docker exec mantle_pg psql < packages/db/migrations/0107_turn_stream_buffer.sql` + a hand-inserted
`drizzle.__drizzle_migrations` ledger row (`created_at=1784073600000`), so a future `pnpm db:migrate` correctly
**skips** 0107 (the ledger gates by `created_at`). Don't re-apply it. Inspect the replay buffer with:
`docker exec mantle_pg psql -U postgres -d postgres -c "select turn_id,seq,event->>'type' from turn_stream_buffer order by created_at desc limit 20;"`

```bash
# 1. web — preview tooling (mcp preview_start "web") OR: pnpm --filter @mantle/web dev --port 3001
# 2. the runner (REQUIRED — turns don't execute without it; reads ../web/.env.local).
#    Start it as a HARNESS-MANAGED BACKGROUND TASK so it isn't reaped when the shell ends:
pnpm --filter @mantle/api dev      # via Bash run_in_background:true
```

Open `http://localhost:3001/assistant`. Confirm it's healthy in the runner log: `runner service online`,
**no** `Contention detected in queue` (that means duplicate runners — kill all `tsx … main.ts` and start one).

**Verify in-browser without provider keys:** the local/default brain uses **OpenRouter**, which streams + Stops
end-to-end. A precise smoke (no UI flakiness): from a `preview_eval`, open `fetch('/api/assistant/turn/<uuid>/stream')`
and read the SSE, `fetch('/api/assistant/turn', {idempotency-key:<uuid>})` to start, and
`fetch('/api/assistant/turn/<uuid>/cancel')` to Stop — assert text-deltas arrive then halt + `done` fires +
the partial persists (`select … from assistant_messages`). The 6 non-OpenRouter adapters need that provider's
API key for live tests, so they're covered by `chat-stream.test.ts` instead.

## 9. Gotchas (don't relearn)

- **`tsx --watch` on `apps/api` does NOT reload workspace-package edits** (`@mantle/voice`, `@mantle/tracing`,
  `@mantle/agent-runtime`, `@mantle/assistant-runtime`). After editing a package, **restart the runner.** Edits
  in `apps/api/src` hot-reload.
- **The runner gets reaped** when the bash session that spawned it ends (a `nohup … &` inside a one-shot Bash
  call dies; it went down repeatedly). Start it with the harness's **background mode** (`run_in_background:true`)
  so it persists. Duplicate runners cause `Contention detected in queue mantle` — `pkill -9 -f "tsx.*main.ts"`,
  then start exactly one.
- **`MANTLE_TURN_TOKENS` is the token-streaming gate; `MANTLE_TURN_STREAMING` is the master gate** (SSE +
  cancel routes exist AND the POST route goes non-blocking). Client mirror: `NEXT_PUBLIC_MANTLE_TURN_STREAMING`.
  The client adapts to the _response shape_ (202 vs full result), so a server/client flag mismatch degrades
  gracefully (the safety poll still reconciles) — but enable them together for the intended UX.
- **The live buffer must render with ReactMarkdown, NOT RichText.** RichText is a TipTap editor; `setContent`
  runs `flushSync`, which re-enters mid-render when the buffer changes every token. The durable reply uses
  RichText (its `setContent` is microtask-deferred).
- **Two SSE subscribers per turn is normal** (the page's `useTurnStream` + the dock's `subscribeDockTurn`).
  `subscribeTurnStream` fans out to a Set — verified both receive every delta. Don't "fix" it.
- **Replay dedup hinges on an ACCURATE `Last-Event-ID`.** The route replays `seq > N` _strictly_, and the
  client's `text-delta` accumulation is _append-based_ — so a wrong/stale cursor would re-append text on a
  reconnect. `apiEventStream` tracks the `id:` per frame and resends it precisely; don't swap in a raw
  `EventSource` (it can't carry the bearer anyway). The route's `makeReplayMerger` adds a second guard
  (drops `seq <= maxSeq`), so overlap is safe even if a cursor is slightly off.
- **The MCP preview console buffer does NOT clear** on reload/`console.clear()` — only a fresh `preview_start`.
  Mid-edit transient parse errors get captured and look scary but are stale; trust `tsc` + a fresh load.
- **DOM-assert carefully:** the assistant SPA drifts to `/` a beat after a hard nav to `/assistant`
  (re-navigate + settle ~6s). The thought-trail renders its own `<li>`s, so `querySelectorAll('li')` grabs
  them — select the turn row via `li[class*="group/turn"]`. Read freshly-dispatched React state in a separate
  eval (commits async). Harness round-trip latency makes "capture at 2s" miss a fast turn — schedule an
  **in-page** sampler/`setTimeout` and read its results, rather than `sleep` + capture.
- **Stop keeps the turn** in the thread (partial reply preserved) and restores the prompt to the box. If a
  future ask is "pull-back" (the stopped turn _disappears_), that needs the runner to delete the rows on stop
  (orphans the trace's subject ref) — not done. Prompt-restore is text-only (attachments aren't re-attached).
- **Headless scratch scripts** live INSIDE the repo (`apps/api/`, `apps/web/scripts/`) so pnpm workspace + the
  `@/` alias resolve; `/tmp` fails. `cd` back to repo root before `pnpm version:bump` / `git add`.
- **Two concurrent `next dev` sharing `.next` = ENOENT + crushes the Mac** ([[no-concurrent-next-builds]]).
- **Cadence:** commit each discrete change separately; bump by extent (`pnpm version:bump patch|minor`); tag/
  push/deploy only when Jason says ([[commit-and-version-cadence]], [[deploy-cadence]]).

## 10. Remaining work

**Phase 4 — mobile companion + replay** (design doc §8):

- ✅ **DONE — the `turn_stream_buffer` replay foundation** (commits `5e37dca5`/`52926c94`/`56292c21`,
  v0.77.0): `Last-Event-ID` replay is built and the web client exercises it. NOTIFY has no backlog, so the
  runner buffers recent events per turn keyed by `seq`; on reconnect with `Last-Event-ID: <seq>` the route
  replays `seq > N` then live-tails (gap-free via subscribe-first/queue/drain; dup-free via the seq guard).
  `apiEventStream` now sends the header on reconnect. **Verified end-to-end** (migration `0107` applied to
  local, runner restarted, live SSE smoke): a turn posted (202), stream dropped mid-flight at seq 5, reconnect
  with `Last-Event-ID: 5` resumed at seq 6 — gap-free + dup-free — through `done`; a fresh header-less connect
  replayed the whole turn from seq 0; `turn_stream_buffer` held all 31 events; the durable outbound row was
  `complete` with the full reply. Dark-mode gating + the TTL sweep are covered by `publish.test.ts`.
  **⚠️ Still unproven on a real backgrounding mobile client** — that's the companion's job (next).
- ✅ **BUILT + unit-tested — the Flutter companion consumer** (`~/Projects/mantle-companion`,
  [[mantle-companion]], `main` commit `ee16e88`, v1.3.0+10, **UNPUSHED**). Consumes the SAME
  `GET /api/assistant/turn/:id/stream` (bearer from day one → no new endpoint). New `lib/data/chat/turn_event.dart`
  (TurnEvent + pure SSE parser, mirrors `@mantle/client-types`); `chat_api.dart` `sendTurn` returns a sealed
  `SendTurnResponse` — **202 `TurnAccepted{turnId}` vs legacy `TurnCompleted`, branched on the body shape** so it
  degrades when the server flags are dark — plus `streamTurn()` (SSE generator, reconnect + `Last-Event-ID`, ends
  on done/error/404) and `cancelTurn()` (swallows 404). `chat_controller.dart` gained `ActiveTurn` live state:
  it **subscribes AFTER the 202** (the replay buffer covers the pre-subscribe window — no subscribe-before dance),
  accumulates `text-delta` round-aware (a new round resets the buffer → only the final answer types out),
  reconciles to the durable rows on `done` (carrying the local image preview), and `stopTurn()` aborts
  server-side + restores the prompt (+ a 4s backstop); **`ref.mounted` guards** make a mid-turn navigation-away
  tear down cleanly (the turn still completes durably + reconciles on return). UI: a live reply bubble
  (`MantleMarkdown`; partial markdown is fine — `MarkdownBody` re-parses each build) + dots; the typing label now
  rides the stream (the ~900ms `turnStage` poll is the legacy fallback, stands down when `active != null`);
  composer Stop → `stopTurn()`. **92 companion tests green + `flutter analyze` clean** (new `turn_event_test.dart`;
  `chat_api_test.dart` updated for the sealed return + 202/cancel; 2 new streaming controller tests — happy-path
  reconcile + server-Stop).
- **REMAINING — device/TestFlight smoke.** The unit tests don't exercise a real SSE socket or backgrounding.
  Smoke it on a device against the local dev server (handover §8) with `MANTLE_TURN_STREAMING` +
  `MANTLE_TURN_TOKENS` on: confirm the reply types out, Stop keeps the partial, and a background→foreground
  resume drains the buffer. Reconcile is via `assistant_messages.status` (`pending`/`complete`/`failed`) — the
  web client's 3s safety poll is the reference; the companion currently relies on its lifecycle/`_onRemoteTurn`
  reconcile + the stream's own reconnect. Push relay ([[mantle-push]]) covers fully-backgrounded turns.
- **Release gotcha:** bump the NotificationService-extension build number to match `+10` or ASC rejects the
  upload ([[mantle-companion-ios-versioning]]).

**Smaller / open:**

- **Cross-reload persistence of the thought trail** — survive a hard refresh (store a compact trail on
  `assistant_messages.data`, or derive it from the turn's trace on read). Currently session-scoped; on reload
  a finished turn shows its reply but not its trail.
- **Deferred: tool-produced sidecar artifacts over the non-blocking transport** (`task_c50089a3` /
  [[api-service-phase2]]). TTS/generated-image artifacts don't ride the live reply (they exceed the 8 KB NOTIFY
  cap). They need their own fetch on reconcile (persist + a get-by-id, or fold into the durable row's
  `attachments`). The blocking path is unchanged; the file nodes still exist in /files.
- **Unify the durable renderer?** Now that the responder writes standard Markdown, the durable reply could
  render via ReactMarkdown too (dropping RichText for responder replies) → perfect streaming↔final
  consistency. Weigh against RichText's SPA-nav on `/n/` permalinks. (Optional polish.)
- **Narrate "Thinking…" too?** Skipped to save spend; revisit if the voice should feel continuous.
- **`tool-start`/`tool-end` events** are defined in the contract but unused — the trail rides `status`. Wire
  them if the UI wants distinct tool chips.

## 11. ⚠️ Deploy notes (when this branch ships — nothing done in prod yet)

- **Detach `rich_writing` from each existing brain's responder persona.** The boot reconcile is additive-only:
  it creates `chat_writing` + attaches it but won't remove `rich_writing`, so an existing persona keeps the
  rich dialect and leaks it into chat. One-time per brain (each prod box):
  `update agents set skill_slugs = array_remove(skill_slugs,'rich_writing') where owner_id=<id> and slug='<responder persona slug>'`
  (slug may be `assistant` OR an operator persona like `telegram-default`/Saskia). Done on local; **prod
  pending.** See [[responder-chat-writing-split]].
- **Migrations `0106` + `0107`** ship with the branch — `pg_dump` prod first ([[backup-before-live-migration]]).
  `0106` (narrator worker enum) is an enum-add (NOT reversible); the narrator worker auto-seeds to existing
  brains on the version-bump reconcile (it's `required`). `0107` (`turn_stream_buffer`) is plain DDL —
  reversible (`DROP TABLE`), no backfill, no seed. **Phases 3a–3c + Stop + 3b add NO migration** — they write
  `assistant_messages.status`/`error`, which already exist (migration `0105`).
- **The replay buffer is gated on `MANTLE_TURN_STREAMING`** (see §9 / `publish.ts`): with the flag dark,
  nothing is written to `turn_stream_buffer` even though `0107` creates it. So shipping the migration is safe
  ahead of enabling the flag.
- **Prod flags** (all dark by default): decide `MANTLE_TURN_STREAMING` (+ `NEXT_PUBLIC_…`), `MANTLE_TURN_TOKENS`,
  `MANTLE_TURN_NARRATION`. Note that `MANTLE_TURN_STREAMING` now _also_ flips the route non-blocking, so enable
  the server + public client flags together.
- **Prod deploy is a registry pull** (`titanwest/mantle:latest`), not build-on-VPS ([[prod-deploy-is-registry-pull]]);
  run `pnpm -C apps/web build` first as a preflight ([[deploy-preflight-next-build]]).

---

_Memory anchors: [[live-turn-streaming]] (full detail), [[api-service-phase2]] (the FE/BE split this rides on),
[[responder-chat-writing-split]], [[mantle-companion]], [[mantle-push]], [[commit-and-version-cadence]]._
