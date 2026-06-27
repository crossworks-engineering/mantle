# Live Turn Streaming — Session Handover

**Branch:** `feat/live-turn-streaming` · **Design doc:** [`docs/live-turn-streaming.md`](live-turn-streaming.md)
**Status:** Steps 0–2 + narrator worker + **Phase 3a (token streaming)** DONE — committed & verified
in-browser (reply types out live; delegated sub-agents stream into the same turn). Remaining in Step 3:
**3b (Anthropic adapter chatStream)** + **3c (status lifecycle + non-blocking route)**.
**Version:** ~v0.72.0 · **Untagged**, **unpushed** (default-branch + tag are Jason's call).

This is the resume point. Read this first, then the design doc for the Step-3 plan.

---

## 1. What's shipped (all on `feat/live-turn-streaming`)

| Commit | What |
|---|---|
| `adb1cdf9` | **Step 0** — contract + cross-process bus |
| `dfaf4219` | **Step 1** — live grounded status from the turn loop |
| `3c1524c5` | fix — read tool args from the nested `{slug,args}` step input |
| `cf4e13db` | **thought-trail UI** — persistent inline record per turn |
| `7005f056` | **Step 2** — narrate the trail in the assistant's voice |
| `044f7b1a` | **narrator worker kind** — its own configurable worker + verbosity dial (v0.71.0) |
| `1542dad4` | **Phase 3a (server)** — `chatStream()` on OpenRouter + tracing delta observer + tool-loop wiring (v0.72.0, flag `MANTLE_TURN_TOKENS`) |
| `e14c109a` | **Phase 3a (client)** — reply types out live, reconciles to the durable reply |
| `33983412` | **delegated sub-agents stream** — child traces inherit the turnId; per-turn seq cursor; reply text stays root-only |

Plus the design doc + a doc-only `282b6cc7`. `main` is reconciled to `98f76e51` (the FE/BE-split fixes that
were stranded on this branch — see git log).

## 2. What it does now (the feature)

During an assistant turn, the chat shows a **thought trail** that builds live and then **persists** as a
collapsible "Thought process · N steps" record above the reply:

```
✨ Thinking…
🔍 Let me look into that for insurance…           ← narrated (Step 2)
✨ Thinking…
🔍 Checking your OUTsurance policy details for you… ← narrated (Step 2)
✨ Thinking…
```

- **Step 1** turns each trace step into a grounded `status` line ("Searching your brain for “insurance”…"),
  pushed the instant the step starts (vs the old 900ms poll), enriched with the tool's query arg.
- **Step 2** upgrades each TOOL line, live and in place, to a warm first-person voice via a cheap remote
  AI worker. "Thinking…" stays plain (no narrator spend).
- The trail freezes onto the reply as a session-scoped record (the durable record is still `/traces`).

## 3. Architecture (the load-bearing facts)

- **Two processes, always.** The turn runs in **`apps/api`** (DBOS runner, no HTTP); the browser's SSE
  socket is served by **`apps/web`** (all `/api/**`). They bridge ONLY via Postgres `NOTIFY` — an
  in-process bus is impossible. (This corrected the original design.)
- **Bus** = `@mantle/turn-stream` (`publishTurnEvent` → `pg_notify('turn_stream', {ownerId,event})`) +
  `subscribeTurnStream(ownerId,turnId,cb)` in `apps/web/lib/realtime.ts`. Owner-filtered; ownerId stripped
  before the browser sees it.
- **Contract** = `TurnEvent` in `@mantle/client-types` (types only). Today only `status` is emitted;
  `text-delta`/`reasoning-delta`/`done`/`tool-*` are defined and waiting for Step 3.
- **The tap** = a generic step observer in `@mantle/tracing` (`setStepObserver`), fired only when a trace
  carries a `turnId`. The turn id = the client's submit uuid (reused as the `Idempotency-Key` →
  `RunAssistantTurnOptions.streamId` → `startTrace` turnId), so the client subscribes BEFORE the turn ends
  with no "return turnId first" needed.
- **Producer** = `apps/api/src/turn-stream-observer.ts`: per step, publish grounded INSTANTLY, then (tool
  steps only, off the critical path, flag-gated) fire the narrator and republish with the same `stepId`.
- **Narrator** = `apps/api/src/turn-narration.ts` — reuses the owner's **`summarizer`** AI worker
  (gemini-flash-lite, remote). `narrateStatus()` never throws; null → keep grounded.
- **Client** = `useTurnStream(turnId)` (`apps/web/components/assistant/use-turn-stream.ts`) accumulates the
  trail, upserting by `stepId` (narrated replaces grounded). `ThoughtTrail` component renders live + record.
  `assistant-client.tsx` wires it in.

## 4. Resume locally (servers + flags + demo)

Local DB is Docker Desktop (NOT Colima this session): `mantle_pg` / `mantle_minio` / `mantle_tika`.
The three flags are already in `apps/web/.env.local` (gitignored, persist):
`MANTLE_TURN_STREAMING=1`, `NEXT_PUBLIC_MANTLE_TURN_STREAMING=1`, `MANTLE_TURN_NARRATION=1`.

```bash
# 1. web dev server (preview tooling, port 3001 — avoids the :3000 .next collision)
#    launch.json already has a "web" config: pnpm --filter @mantle/web dev --port 3001
# 2. the runner (REQUIRED — turns don't execute without it on local DB):
pnpm --filter @mantle/api dev          # reads ../web/.env.local
```
Then open http://localhost:3001/assistant and send something that forces a tool, e.g.
*"Search my notes for anything about insurance and summarize."* Watch the trail narrate.

## 5. Gotchas learned (don't relearn)

- **`tsx --watch` on `apps/api` does NOT reload changes in workspace packages** (e.g. editing
  `@mantle/assistant-runtime`). Restart the runner after a package edit. Edits inside `apps/api/src` do
  hot-reload.
- **The runner takes SIGTERM if a bash session reaps it** — it died once mid-session. If turns hang on
  "typing…" forever, check `pgrep -f apps/api/src/main.ts` and restart.
- **A turn answered from conversation context does NO tool call** → trail shows only "Thinking…" (1 step,
  no narration). For a narration demo, ask about something fresh.
- **Early-step race:** the client subscribes ~100-300ms after send, so the very first "Thinking…" can be
  missed. The durable reply always lands; the §2 buffer (Step 4) is the real fix.
- **Headless smoke for module resolution:** scratch scripts must live INSIDE the repo (e.g. a temp file in
  `apps/api/`) so pnpm workspace resolution works; `/tmp` fails with MODULE_NOT_FOUND.
- **`cd` persists across Bash calls** — `cd` back to repo root before `pnpm version:bump` / `git add`.

## 6. Step 3 — token streaming

**DBOS was NOT the obstacle** (the worry going in): DBOS journals a step's *return value*; the per-token
`publishTurnEvent` calls are non-journaled side effects inside the LLM step. Durability (the journaled
`ChatResult`) and liveness (tokens on the NOTIFY bus) ride separate paths automatically — no new
library/service needed. The audit confirming this is in the commit history; see §5b of the design doc.

**3a — DONE (`1542dad4` server, `e14c109a` client, `33983412` delegation).** `chatStream()` on OpenRouter
returns the final `ChatResult` (journaled) AND publishes `text-delta`/`reasoning-delta` via a tracing
delta-observer (`setTurnDeltaObserver`/`emitTurnDelta`/`isTurnStreaming`, sibling of the step observer).
`usage:{include:true}` keeps cost tracking; tool-call args accumulate by index. The tool-loop's
`dispatchChat` picks chatStream when streaming is active. Gated by **`MANTLE_TURN_TOKENS`** (installing the
delta observer is what flips `isTurnStreaming()` on — fully dark otherwise). The web route still BLOCKS on
`getResult()` — token streaming is independent of that, so the route-flip is deferred to 3c. Client:
`useTurnStream` accumulates `text-delta` (latest round) → the reply types out, reconciles to the durable
reply when the POST lands. **Delegated sub-agents stream too**: child traces inherit the parent turnId, the
seq cursor is per-TURN (root + children share it), and `isStreamRoot` keeps the visible reply text to the
top-level turn while sub-agent STATUS surfaces in the trail.

**Remaining:**
- **3b** — `chatStream()` on the **Anthropic** adapter (native `messages` streaming; `content_block_delta`
  text + thinking). Only matters for brains on the `anthropic` provider directly — the openrouter path
  (incl. `anthropic/claude-*` *via* OpenRouter) already streams.
- **3c** — wire `assistant_messages.status` (`pending → complete/failed`) + emit `done`/`error` terminal
  events + flip the web route to **return `turnId` immediately** instead of awaiting `getResult()`. This is
  the mobile/background-grade piece (the companion reconnects + reconciles against the durable row).

## 7. Open ideas / decisions (Jason's, captured)

- ~~**Promote the narrator to its own `narrator` worker kind**~~ — **DONE (`044f7b1a`, v0.71.0).**
  `narrator` is now a real worker kind (enum migration `0106`, `NarratorParams`, manifest entry, the full
  AI-workers Settings form, `CAPABILITY_FOR_KIND`). `narrateStatus` resolves the `narrator` worker first and
  honours its `systemPrompt` (the **verbosity dial** — phrase vs sentence vs paragraph) + `temperature`/
  `max_tokens`; brains without one fall back to `summarizer` + the built-in concise prompt (zero
  regression). The narrator is a **required baseline worker** ⇒ auto-seeds on fresh onboarding AND reaches
  existing brains on the next upgrade (the reconcile's `requiredOnly` pass), same `gemini-3.1-flash-lite` as
  the indexing workers. It isn't part of the indexing pipeline, so the health checks were de-coupled from
  "indexing degraded" wording (config-diff message generic; integrity §8 → "Baseline workers", ready-list
  derived from the required kinds). The one-line `tidy` cap was relaxed 80→400 so a longer setting isn't
  truncated. Verified end-to-end on the local brain (concise fallback vs a full paragraph once a tuned
  narrator worker is the default) and the `requiredOnly` reconcile path (seeds the narrator onto an existing
  brain).
- **Cross-reload persistence** of the thought record (survive a hard refresh): store a compact trail on the
  outbound `assistant_messages.data`, or derive it from the turn's trace on read. Currently session-scoped.
- **Narrate "Thinking…" too?** Skipped today to save spend; revisit if the voice should be continuous.
