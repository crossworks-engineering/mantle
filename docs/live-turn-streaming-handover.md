# Live Turn Streaming — Session Handover

**Branch:** `feat/live-turn-streaming` · **Design doc:** [`docs/live-turn-streaming.md`](live-turn-streaming.md)
**Status:** Steps 0–2 DONE, committed, and live-verified in-browser. Next destination: **Step 3 (token streaming).**
**Version:** ~v0.70.0 · **Untagged**, **unpushed** (default-branch + tag are Jason's call).

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

## 6. Step 3 — the next destination (token streaming)

See [`docs/live-turn-streaming.md`](live-turn-streaming.md) §5–§7, §9. In short:
1. Add `chatStream()` to the **OpenRouter** adapter, then **Anthropic** — each RETURNS the final
   `ChatResult` (durable, journaled by DBOS) AND publishes `text-delta`/`reasoning-delta` (ephemeral).
   `usage:{include:true}` so cost tracking survives. Tool-call args stream as fragments → accumulate, parse
   at `finish_reason`.
2. Flip the web route to **return `turnId` + stream** instead of awaiting `getResult()`.
3. Wire the `assistant_messages.status` lifecycle (`pending → complete/failed`) + client reconciliation: on
   `done`, replace the streamed buffer with the durable DB text.
4. The hard part is the **DBOS durability/liveness split** — the journal records the final result; tokens
   ride the ephemeral NOTIFY bus around it. The `text-delta` event type already exists in the contract.

## 7. Open ideas / decisions (Jason's, captured)

- **Promote the narrator to its own `narrator` worker kind** (enum migration + manifest + drift type), so
  its model/prompt/params are managed in Settings separately from `summarizer`. **Key payoff (Jason's
  note):** a user-tunable **verbosity** — a phrase vs a sentence vs a *paragraph* — via the narrator
  worker's `systemPrompt`/params ("a skill that tells it how much to say"). The call site
  (`narrateStatus`) won't change; just swap `getDefaultWorker('summarizer')` → `('narrator')`.
- **Cross-reload persistence** of the thought record (survive a hard refresh): store a compact trail on the
  outbound `assistant_messages.data`, or derive it from the turn's trace on read. Currently session-scoped.
- **Narrate "Thinking…" too?** Skipped today to save spend; revisit if the voice should be continuous.
