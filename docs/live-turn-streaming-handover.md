# Live Turn Streaming — Session Handover

**Branch:** `feat/live-turn-streaming` · **Version:** v0.74.0 · **Untagged, unpushed** (default-branch +
tag + deploy are Jason's call). **Design doc:** [`docs/live-turn-streaming.md`](live-turn-streaming.md).

**Status:** Phases 0–2 + the narrator worker + **Phase 3a (token streaming)** + **Phase 3c (durable status
lifecycle + non-blocking route)** are DONE, committed, and browser-verified. The reply types out live and the
turn route now returns **202 immediately** — the client drives completion off the live stream and reconciles
to the durable `assistant_messages` row, so a turn survives navigation/backgrounding. **Next up: Phase 3b
(Anthropic native streaming) and Phase 4 (mobile companion + replay).**

This is the resume point — read this, then the design doc §5–§9 for the 3b/Phase-4 detail.

---

## 1. What shipped (newest first, all on `feat/live-turn-streaming`)

| Commit | Ver | What |
|---|---|---|
| `5a445e1c` | 0.75.0 | **Stop mid-flight** — the Enter button becomes a Stop button; cross-process abort halts generation, keeps the partial reply. |
| `368aa3a8` | 0.74.0 | **Phase 3c Part B** — non-blocking route (202 `{turnId}`) + client/dock drive off the live stream, reconcile to the durable row on done/error. |
| `15c58f8a` | 0.73.0 | **Phase 3c Part A** — runner owns the durable outbound row (pending→complete/failed) + emits `turn-start`/`done`/`error` via a tracing turn-lifecycle observer. |
| `99038998` | 0.72.3 | **Responder → standard Markdown.** New `chat_writing` skill (no rich dialect); Pages keeps `rich_writing`. |
| `937fa97e` | 0.72.2 | **Stick-to-bottom autoscroll** + a jump-to-latest button. |
| `97fdd066` | 0.72.1 | **flushSync fix** — live buffer renders via ReactMarkdown; RichText `setContent` deferred to a microtask. |
| `9769c90e` | — | docs: Phase 3a. |
| `33983412` | 0.72.0 | **Delegated sub-agents stream** into the same turn (turnId inheritance, per-turn seq, `isStreamRoot`). |
| `e14c109a` | 0.72.0 | **Phase 3a client** — the reply types out live, reconciles to the durable reply. |
| `1542dad4` | 0.72.0 | **Phase 3a server** — `chatStream()` on OpenRouter + tracing delta observer + tool-loop wiring (flag-dark). |
| `5673e880` | 0.71.0 | Narrator made a **required baseline worker** (auto-seeds on onboarding + upgrade). |
| `044f7b1a`/`5b206060` | 0.71.0 | Narrator promoted to its **own configurable worker kind** (verbosity dial). |

Earlier (prior session): `adb1cdf9` Step 0 (contract + bus), `dfaf4219` Step 1 (grounded status), `cf4e13db`
thought-trail UI, `7005f056` Step 2 (narration). `main` is reconciled to `98f76e51` (the FE/BE-split fixes).

## 2. What the feature does now

During an assistant turn the chat shows a **live thought trail** (status, narrated in the assistant's voice)
AND, with token streaming on, the **reply types out** below it — then reconciles to the durable reply when
the POST lands. **Delegated sub-agents** (e.g. the Pages specialist) now surface their own steps in the same
trail. The transcript **follows new content while you're at the bottom** and offers a jump button if you've
scrolled up. The responder writes **standard Markdown** (portable to web + mobile); the **Pages** specialist
still authors the rich Mantle dialect for documents.

## 3. Architecture — the load-bearing facts

- **Two processes, always.** The turn runs in **`apps/api`** (DBOS runner, no HTTP); the browser's SSE
  socket is served by **`apps/web`** (all `/api/**`). They bridge ONLY via Postgres `NOTIFY` (`turn_stream`
  channel). `@mantle/turn-stream` `publishTurnEvent` → `pg_notify`; `subscribeTurnStream` in
  `apps/web/lib/realtime.ts` (owner+turn filtered; ownerId stripped before the browser).
- **DBOS was NOT the streaming obstacle.** DBOS journals a step's *return value* (the assembled
  `ChatResult`); the per-token `publishTurnEvent` calls inside the LLM step are non-journaled side effects.
  Durability (journal) and liveness (NOTIFY bus) ride separate paths automatically — **no new lib/service
  needed.** On crash-resume the step re-runs and re-streams; the answer is never lost (it's the return value).
- **The web route is now NON-BLOCKING** (3c, `route.ts`): when `isTurnStreamingEnabled()` and the client
  sent an idempotency-key, it enqueues and returns **202 `{turnId}`** immediately (no `getResult()`). The
  client types the reply off the stream and reconciles to the durable row on `done`. The legacy blocking
  relay stays for flag-off (and any no-key POST). The **runner owns the outbound row**: inserts it `pending`
  at turn start, finalizes it `complete`/`failed` (`run-turn.ts`).
- **Contract** = `TurnEvent` in `@mantle/client-types` (v, turnId, seq, round, type, data). All emitted now:
  `status`, `text-delta`, `reasoning-delta`, and (3c) `turn-start` (carries inbound/outbound row ids),
  `done`, `error`. `turnId` on the wire = the client's idempotency-key/streamId (the stable
  subscribe-before-rows-exist handle); the durable outbound row id rides in `turn-start`.
- **Stop a turn mid-flight** (`5a445e1c`): the composer's Enter button becomes a red Stop button while a
  turn streams. Cross-process abort: `POST /api/assistant/turn/:id/cancel` → `publishTurnCancel` →
  `turn_cancel` NOTIFY → the runner's cancel listener (`apps/api/src/turn-cancel.ts`) → `abortTurn(owner,
  turnId)` aborts a per-turn `AbortController` (registry in `store.ts`). The tool loop threads
  `currentTurnAbortSignal()` into `chatStream` → the OpenRouter SDK fetch; on abort the adapter returns its
  PARTIAL reply (not a throw), so `run-turn` finalizes the row `'complete'` with the partial (a stop is
  detected via `signal.aborted`, distinct from a real error). Generation halts ~360ms after the click.
- **Turn-lifecycle observer** (3c, third tracing observer in `store.ts`): `setTurnLifecycleObserver`/
  `emitTurnLifecycle(turnId, ownerId, phase, data)`. Driven EXPLICITLY by the runtime (not the trace) so
  `turn-start` fires once the rows exist and `done`/`error` fire once the outbound text is committed (which
  is AFTER the responder trace closes). It owns the per-turn seq-cursor retirement on done/error, so seq
  stays monotonic past the trace boundary (`startTrace` defers cleanup to it when a runner is wired).
- **Two tracing observers** (siblings, in `packages/tracing/src/store.ts`), set by `apps/api` at boot
  (`turn-stream-observer.ts`), no-op unless a trace carries a `turnId`:
  - **step observer** (`setStepObserver`) → `status` events (the trail). Installed always.
  - **turn-delta observer** (`setTurnDeltaObserver`/`emitTurnDelta`/`isTurnStreaming`) → `text-delta`/
    `reasoning-delta`. Installed **only when `MANTLE_TURN_TOKENS` is set** — installing it is ALSO the gate
    that flips `isTurnStreaming()` on, so the tool-loop only uses `chatStream` when the flag is set.
- **`chatStream()`** is an optional `ChatDispatcher` method (`packages/voice/src/adapters/types.ts`).
  **OpenRouter implements it** (`openrouter-chat.ts`): `stream:true` + `usage:{include:true}`, iterates the
  SDK EventStream, fires `onDelta` per text/reasoning chunk, accumulates tool-call arg fragments by index,
  returns the SAME `ChatResult` as `chat()`. The tool-loop's `dispatchChat` (`tool-loop.ts`) picks it over
  `chat()` when streaming is active — at the main round, the failover-backup round, and the force-final pass.
- **Delegated agents stream into the same turn.** `invokeAgent` opens the child in its own trace (for cost);
  `startTrace` now **inherits the parent's `turnId`** so the child's steps fire the observers. The live
  `seq` cursor is **per-turn** (a `turnId→counter` registry in store.ts), so root + children share one
  monotonic sequence. A new **`isStreamRoot`** flag gates the reply-text stream to the top-level turn (a
  sub-agent's tokens are intermediate — its status surfaces in the trail, its text doesn't pollute the reply).
- **Client** (`apps/web/app/(app)/assistant/`): `use-turn-stream.ts` `useTurnStream(turnId)` returns
  `{label, trail, reply}` — accumulates `text-delta` into a latest-round reply buffer (ref accumulator).
  `assistant-client.tsx` renders the **live buffer with ReactMarkdown** (NOT RichText — see gotchas), the
  trail with `ThoughtTrail`, and on the durable POST reply swaps in `RichText`. Stick-to-bottom lives here too.
- **Narrator** is its own **required baseline worker kind** (`narrator`, migration `0106`). `narrateStatus`
  (`apps/api/src/turn-narration.ts`) resolves it first, falls back to `summarizer`; its `system_prompt` is a
  user-tunable verbosity dial (Settings → AI workers). See [[live-turn-streaming]] memory for full detail.
- **Formatting skills** (manifest): responder = **`chat_writing`** (standard Markdown only); Pages =
  **`rich_writing`** (the rich dialect) — unchanged. See [[responder-chat-writing-split]].

## 4. Resume locally (servers + flags)

Local DB is **Docker Desktop** (`mantle_pg`/`mantle_minio`/`mantle_tika`); `DATABASE_URL` =
`127.0.0.1:54323` (line 10 of `apps/web/.env.local`; the prod-tailnet + tunnel URLs are commented below it).
Owner id = `bc505da9-c323-43c7-bafb-6c06a2d443de`. The four flags are already in `.env.local` (gitignored):
`MANTLE_TURN_STREAMING=1`, `NEXT_PUBLIC_MANTLE_TURN_STREAMING=1`, `MANTLE_TURN_NARRATION=1`,
`MANTLE_TURN_TOKENS=1`.

```bash
# 1. web dev server — use the preview tooling (mcp preview_start "web") OR:
pnpm --filter @mantle/web dev --port 3001     # .claude/launch.json "web" config
# 2. the runner (REQUIRED — turns don't execute without it; reads ../web/.env.local):
pnpm --filter @mantle/api dev
```
Open `http://localhost:3001/assistant`. A plain question types out live. To see delegation stream, force it:
*"Create a new page titled X with two short sections"* (the persona lacks the `pages` authoring group, so it
MUST delegate to the Pages specialist). The runner logs to wherever you redirect it; `[assistant_turn] done`
marks completion.

## 5. Gotchas (don't relearn)

- **`tsx --watch` on `apps/api` does NOT reload workspace-package edits** (`@mantle/voice`, `@mantle/tracing`,
  `@mantle/agent-runtime`). After editing a package, **restart the runner**. Edits in `apps/api/src` hot-reload.
- **The runner gets reaped** (SIGTERM) when a bash session that spawned it ends — it went down ~3× this
  session. If turns hang, `pgrep -f apps/api/src/main.ts`; restart it (background it from a fresh shell).
- **Skill/worker changes are DB-side** — a seed (`seed:rich-writing`, the scratch scripts) or `applyManifest`
  writes the DB; the running runner picks them up per turn (no restart). But a *code* change needs a restart.
- **MANTLE_TURN_TOKENS is the streaming gate.** Flag off ⇒ `isTurnStreaming()` false everywhere ⇒ the turn
  runs the one-shot `chat()` (zero behaviour change). Flag on (runner installs the delta observer) ⇒ streams.
- **Live buffer must NOT use `RichText`.** RichText is a TipTap editor; `setContent` runs `flushSync`, which
  re-enters mid-render when the buffer changes every token. Use ReactMarkdown for the live buffer; RichText's
  own `setContent` is now microtask-deferred (it errored once per visible turn on load before).
- **The MCP preview console buffer does NOT clear on reload or `console.clear()`** — only a fresh
  `preview_start` resets it. To tell stale errors from live ones, restart the preview server and load once.
- **The assistant SPA drifts to `/`** a beat after a hard nav to `/assistant` — re-navigate and re-check
  (it settles). When asserting on a freshly-dispatched scroll/React state, read it in a SEPARATE eval (state
  commits async).
- **The persona delegates non-deterministically.** "Use your researcher" sometimes gets refused ("I don't
  have a researcher") even though it's wired. The reliable delegation trigger is page authoring (persona has
  no `pages` group → must delegate to Pages).
- **Headless scratch scripts** live INSIDE the repo (`apps/api/`, `apps/web/scripts/`) so pnpm workspace +
  the `@/` alias resolve; `/tmp` fails. `cd` persists across Bash calls — `cd` back to repo root before
  `pnpm version:bump` / `git add`.
- **Two concurrent `next dev` sharing `.next` = ENOENT + crushes the Mac** ([[no-concurrent-next-builds]]).
  Stop the other chat's server before starting your own.

## 6. Remaining work

**Phase 3b — Anthropic `chatStream()`** (`packages/voice/src/adapters/anthropic-chat.ts`). Native `messages`
streaming: `content_block_delta` text + (if enabled) thinking deltas; same return-the-ChatResult + onDelta
contract as OpenRouter. Only matters for brains on the `anthropic` provider *directly* — the OpenRouter path
(incl. `anthropic/claude-*` via OpenRouter, which is what the local + default brains use) already streams.
Mirror the OpenRouter adapter's structure + its 4 wire-shape tests.

**Phase 3c — message lifecycle + non-blocking route — ✅ DONE** (`15c58f8a` Part A, `368aa3a8` Part B). All
three pieces landed + browser-verified: `assistant_messages.status` is wired (runner inserts `pending`,
finalizes `complete`/`failed`); `turn-start`/`done`/`error` terminal events fire on the bus via the
turn-lifecycle observer; the web route returns 202 `{turnId}` immediately and the client + dock drive off the
stream and reconcile to the durable row. See §1/§3 above. **One known-deferred gap:** tool-produced sidecar
artifacts (TTS/generated images) over the non-blocking transport (the existing `task_c50089a3` /
[[api-service-phase2]] item) — the blocking path is unchanged, and the durable file nodes still exist in
/files; the live non-blocking reply just won't carry them until that transport lands. If you pick this up:
artifacts exceed the 8 KB NOTIFY cap, so they can't ride a `done` event — they need their own fetch on
reconcile (persist + a get-by-id, or fold into the durable row's `attachments`).

**Phase 4 — mobile companion + replay** (design doc §8): the Flutter companion (`~/Projects/mantle-companion`)
consumes the same `GET /turn/:id/stream` (bearer header, not cookie); add the `turn_stream_buffer` table for
`Last-Event-ID` replay/resume (NOTIFY has no backlog). The web client already tolerates a missed terminal
event (a 3s `syncLatest` safety poll on the durable row) — mobile should reconcile against
`assistant_messages.status` the same way. Push relay covers backgrounded turns.

**Smaller / open:**
- **Cross-reload persistence of the thought record** — survive a hard refresh (store a compact trail on
  `assistant_messages.data`, or derive from the turn's trace on read). Currently session-scoped.
- **Unify the durable renderer?** Now that the responder writes standard Markdown, the durable reply could
  render via ReactMarkdown too (dropping RichText for responder replies) for perfect streaming↔final
  consistency. RichText still gives SPA-nav on `/n/` permalinks — weigh that. (Optional polish.)
- **Narrate "Thinking…" too?** Skipped to save spend; revisit if the voice should be continuous.

## 7. ⚠️ Deploy notes (when this branch ships)

- **Detach `rich_writing` from each existing brain's responder persona** — the boot reconcile is
  additive-only; it creates `chat_writing` + attaches it, but won't remove `rich_writing`, so an existing
  persona keeps the dialect and still leaks it into chat. One-time per brain (prod, Ashley):
  `update agents set skill_slugs = array_remove(skill_slugs,'rich_writing') where owner_id=<id> and <responder persona slug>`
  (persona slug may be `assistant` OR an operator persona like `telegram-default`/Saskia). Done on local;
  prod pending. See [[responder-chat-writing-split]].
- The narrator worker auto-seeds to existing brains on the version-bump reconcile (it's `required`); no step.
- Migration `0106` (narrator enum) ships with the branch — `pg_dump` prod before `db:migrate`
  ([[backup-before-live-migration]]); enum-adds aren't reversible. **3c adds NO new migration** — it writes
  `assistant_messages.status`/`error`, which already exist (migration `0105`, shipped earlier).
- Flags for prod: decide whether to enable `MANTLE_TURN_STREAMING` / `MANTLE_TURN_TOKENS` /
  `MANTLE_TURN_NARRATION` there (all dark by default). **Note (3c):** `MANTLE_TURN_STREAMING` now also flips
  the route non-blocking (202 instead of the awaited result). The client adapts to the response shape, so a
  server/client flag mismatch degrades gracefully (the safety poll still reconciles), but enable the server
  + `NEXT_PUBLIC_MANTLE_TURN_STREAMING` together for the intended UX.
