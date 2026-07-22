# `ask_human` UX — reach the operator, ask like a questionnaire

Status: **PLAN — awaiting implementation** (designed 2026-07-22; execute in
worktree branch `claude/runner-workers-ask-human-70dba0`).
Prereqs read: [runs.md](runs.md), [runs-slice-3-plan.md](runs-slice-3-plan.md)
§4 WP3, `packages/runs/src/{engine,human,sweep}.ts`,
`packages/tools/src/{pending,pending-notify}.ts`,
`apps/web/components/assistant/assistant-dock.tsx`, `apps/web/lib/realtime.ts`,
`apps/web/workers/push-notify.ts`.

## The problem, in two sentences

A run parked on an `ask_human` gate is **silent**: the engine inserts the
`pending_tool_calls` row inside its transaction and never fires the pending
fan-out, so there is no live badge repaint, no companion push, no Telegram
card — the operator discovers a blocked run only by visiting `/pending`. And
even once found, the answer surface is a bare row: no designed questionnaire,
no structured options with an "Other" escape, nothing in the global assistant
surface where the operator actually lives.

## Target behaviour (Jason's spec, 2026-07-22)

When an `ask_human` (or `run_budget`) row is created:

1. **Global chat first** — the assistant panel / global chat surface shows a
   well-designed questionnaire card (Claude `AskUserQuestion`-style: option
   chips + an "Other" free-text escape), answerable in place.
2. **The assistant button flashes** — the footer `AssistantButton` gets an
   unmissable "needs you" state.
3. **A web toast** fires with an action that opens the questionnaire.
4. **mantle-companion gets a push** (deep-linking to the question).
5. Telegram keeps working as an approval surface (option-aware card is a
   stretch goal, not v1).

Design constraint from Jason: **don't over-bind to `ask_human`** — considered
adding a separate `show_questionnaire`; decision below is to extend the
`ask_human` payload instead (rationale in WP1) and keep the renderer generic
so a future non-run inline tool can reuse it.

## Architecture facts the implementer must not rediscover

- `notifyPendingCreated` (`packages/tools/src/pending-notify.ts`) is the ONE
  fan-out for approvals: `pg_notify('pending_changed', ownerId)` (→ web
  realtime bridge repaints the sidebar badge + `/pending`; → `push-notify`
  worker sends the companion device push via `pushApproval`) plus the
  Telegram approval card (routed by `reminderChannel` — `mobile` operators
  get push-only, others get the card). **Firing this one function lights up
  badge, push, and Telegram for free.**
- **Layering is circular-locked**: `@mantle/tools` imports `@mantle/runs`
  (`applyHumanAnswer`, `RUN_BUDGET_TOOL_SLUG`), so `@mantle/runs` can NEVER
  import `@mantle/tools`. The engine cannot call `notifyPendingCreated`
  directly — use the registration seam (WP0).
- The engine's discipline: transitions run in one transaction and return
  `PostCommitAction[]`; callers enqueue after commit via
  `enqueueRunActionsSafe` (`packages/runs/src/boss.ts`). Notify must follow
  the same shape — **never a side effect inside the transaction**.
- Two creation sites for silent rows: `promote()`'s `ask_human` branch
  (`engine.ts` ~732) and `completeItem`'s budget-pause branch (`engine.ts`
  ~455–486, `run_budget`).
- Client realtime already exists end-to-end:
  `useRealtime(['pending_tool_call'], cb)`
  (`apps/web/components/realtime/use-realtime.ts`) is what the sidebar badge
  and `/pending` use today. No new channel, no polling.
- `/api/pending` (GET, owner-scoped, `?limit=`) already returns full rows
  incl. `args`; PATCH `/api/pending/:id` `{decision, answer?}` already
  answers. `pending_approve` over MCP takes `answer` too.
- Toast is home-grown (`apps/web/components/ui/toast.tsx`, ~80 LOC queue,
  message-only). UI rules: `apps/web/CLAUDE.md` + `docs/ui-style-guide.md`
  (theme tokens only, shadcn-first, SubmitButton labels, min-h-0).
- Detached dev (`pnpm dev:fe`): client code must fetch via
  `apiFetch`/`apiSend` only — the new watcher/hook must not read the DB in a
  server component on the shell path.

---

## WP0 — the fan-out (fix the silent question) — backend, small, ship-first

The whole notification stack turns on with this WP alone; everything after
is presentation.

1. **New action type.** Extend `PostCommitAction` (engine.ts):
   `{ type: 'pending_created'; ownerId: string; pendingId: string;
   toolSlug: 'ask_human' | 'run_budget'; args: Record<string, unknown> }`.
   Emit it from both creation sites (capture the inserted row's id via
   `.returning()`). The action is **advisory**: losing it loses a
   notification, never correctness (the row is the truth; the badge catches
   up on next page load). Do NOT add sweep re-send machinery for it.
2. **Registration seam.** In `@mantle/runs` (new `notify.ts`):
   `registerPendingCreatedNotifier(fn)` + module-level slot, mirroring the
   `registerAgentInvoker` idiom. `enqueueRunActions` (boss.ts) handles
   `pending_created` by calling the registered notifier (await, but wrap in
   try/catch — soft-fail like every arm of the fan-out); if unregistered,
   log once and drop.
3. **Wire it.** `@mantle/tools` registers `notifyPendingCreated` at module
   load (in `pending.ts` or `index.ts` — it already imports `@mantle/runs`).
   Verify each PROCESS that executes these actions imports `@mantle/tools`:
   web/api do (tool loop); the `worker_runs` container and the sweep path
   must be checked — if `apps/web/workers/runs.ts` doesn't already pull in
   `@mantle/tools`, add the import for the registration side effect (comment
   why).
4. **Tests.** Engine suite: promote(ask_human) and the budget-pause path
   return the `pending_created` action with the row id + args. boss.ts:
   notifier called post-commit-shape; unregistered → no throw. Existing
   action assertions in `engine.test.ts` will need the new member.

Acceptance: with `MANTLE_RUNS=1`, planning a run with an `ask_human` step
makes the sidebar badge repaint live, the companion push fire (for `mobile`
channel), and the Telegram card arrive — with zero UI work.

## WP1 — structured questionnaire payload (one kind, richer form)

**Decision: extend `ask_human`; no new item kind, no new tool (v1).**
Rationale: the engine treats a question item purely as
promote-park-complete — a second kind would duplicate the promote branch,
both sweep exemptions, the janitor, and the answer path for zero engine
difference. The extension is payload-only and fully backward compatible.
If a future need arises for a mid-turn inline questionnaire *outside* runs
(the "`show_questionnaire` maybe" idea), it becomes a `requires_confirm`-style
tool that mints the same-shaped pending row and reuses the same renderer —
nothing in this WP blocks that.

1. **Plan leaf** (parser in `packages/tools/src/builtins-runs.ts` ~235):
   `{kind:'ask_human', question, options?, timeout_seconds?, form?}` where
   `form.questions[]` (1–4) each:
   `{ id?: string, header?: string (≤24 chars), question: string,
   options: [{label: string (≤80), description?: string (≤200)}] (0–8),
   multi_select?: boolean, allow_other?: boolean (default true) }`.
   Legacy `question`+`options` (flat strings) stays legal and is the simple
   case; when `form` is present it wins and `question` becomes the headline.
   Teaching errors per the tools CLAUDE.md style guide; total payload cap
   ~8 KB. Update `run_plan`'s description/schema minimally (budget-conscious
   — schema carries the shape, prose only the judgment call).
2. **Promote** copies `form` into the pending row args verbatim (args are
   already the transport; MCP `pending_list`/`pending_get` then show it too).
3. **Answer shape.** PATCH `/api/pending/:id` and MCP `pending_approve` gain
   optional `answers`: `[{ question: string (id or header or index),
   selected: string[], other?: string }]`, validated loosely against the
   row's form (unknown question → teaching error; free-text `answer` remains
   valid and sufficient). `applyHumanAnswer` passes it through:
   `result.answer` (joined human-readable string — keeps every existing
   consumer working) + `result.answers` (the structured array).
4. **Compiled state** (`packages/runs/src/state.ts` case 'ask_human'):
   render answers readably (`Q → selected (+ other)` lines) so downstream
   steps and the resume prompt see the decision verbatim.
5. **Tests.** Parser validation (caps, teaching errors, legacy shape);
   `pending.test.ts` structured-answer settle; a state-renderer test.

## WP2 — the questionnaire card (one renderer, three surfaces)

`apps/web/components/pending/questionnaire-card.tsx` (client):

- Input: the `PendingRow` (id, toolSlug, args). Renders:
  - `ask_human`: question headline; per-form-question sections with header
    chip, option buttons (single-select = radio-like chips; multi = toggle
    chips), descriptions as muted subtext, an "Other…" free-text input when
    `allow_other`; legacy flat `options` render as one chip row.
    Footer: `<SubmitButton>` "Answer & continue" (disabled until every
    non-optional question has a selection or other-text) + ghost "Reject".
  - `run_budget`: the question text + "Raise budget" / "Cancel run" (labels
    as on `/pending` today).
- Submit → PATCH `/api/pending/:id` `{decision:'approve', answer, answers}`;
  one-click single-question chips may submit immediately (parity with
  today's `/pending` chips). Handle the `moved_on`/expired teaching error by
  showing it on the card (the run moved on).
- Style: theme tokens only, `bg-card`/`border-border`, accent pairing rules;
  compact enough to sit inside the assistant panel column.
- **Refactor `/pending`** (`pending-client.tsx`) to use this card for
  `ask_human`/`run_budget` rows — one renderer, no drift.

Plus a shared hook `usePendingQuestions()`
(`apps/web/components/pending/use-pending-questions.ts`): React Query on
`/api/pending?limit=50`, filtered to `status==='pending' &&
toolSlug in ('ask_human','run_budget')`, invalidated by
`useRealtime(['pending_tool_call'])`. Exposes `{questions, count}`.
(Optional: add `?slug=` server filter to the GET route; not required at
these volumes.)

## WP3 — global chat surfacing, flash, toast

1. **Assistant panel** (`assistant-panel.tsx`): when `usePendingQuestions`
   has rows, render the questionnaire card(s) pinned at the top of the
   transcript area (scroll with it if >1; newest first, cap visible at 3
   with a "view all on /pending" link). Answering removes the card live
   (query invalidation already handles it).
2. **`AssistantButton` flash** (`assistant-dock.tsx`): consume the hook's
   `count`. When >0 and the panel isn't open: swap the sparkle for a
   distinct "needs you" treatment — pulsing ring
   (`animate-pulse ring-2 ring-primary`) + a small count badge (reuse the
   HighlightButton badge pattern), `aria-label` updated ("Assistant — 1
   question needs you"). Flash stops when the panel opens (the card is then
   visible) — not when answered, when *seen*.
3. **Toast**: extend `ToastApi.push` with optional
   `action?: { label: string; onClick: () => void }` (small addition to the
   home-grown queue; render as a link-style button). New headless
   `<PendingQuestionWatcher/>` mounted once in the app shell (inside both
   `ToastProvider` and `AssistantDockProvider`): tracks seen ids in a ref;
   on a NEW id appearing *after mount* (never on initial load — no toast
   storm on refresh), `toast.info` with the question preview (~80 chars) and
   action "Answer" → `openAssistant()` . `run_budget` wording: "Run paused —
   budget decision needed".
4. **Detached-dev + zero-cost idle**: the hook must no-op cheaply when there
   are no questions (it already only refetches on realtime events; initial
   fetch is one small GET). Everything client-side via `apiFetch`.

## WP4 — companion + Telegram polish (v1-optional, do last or defer)

- **Companion push copy**: `pushApproval` (push-notify worker path) sends a
  generic approval push today. Make it question-aware: when the newest
  pending row is `ask_human`, the push title/body carry the question text
  (truncated); deep link stays `/pending`. Verify in
  `apps/web/lib/push*`/`packages/push*` (wherever `pushApproval` lives).
- **Telegram option answering** (the known gap): `sendApprovalCard` shows
  Approve/Reject only, and `telegram-poll.ts` calls
  `approvePendingCall(ownerId, pendingId)` with no answer. Stretch: for
  `ask_human` rows with ≤4 flat options, render one inline button per option
  (callback data `pendingId:optIdx`) and pass the picked label as `answer`.
  Multi-question forms stay web-only (the card links to `/pending`). If
  time-boxed out: ship v1 with today's yes/no card — rejecting is safe
  (`failed({type:'rejected'})` is a designed outcome) and the web card is
  the primary surface.

## Sequencing, gates, non-goals

- Order: **WP0 → WP1 → WP2 → WP3 (→ WP4)**. WP0 is independently shippable
  and testable; WP1 before WP2 so the card renders the real shape.
- Everything stays **dark behind `MANTLE_RUNS`** except: WP3's watcher/hook
  run on every brain — they see zero rows when runs are off *but also serve
  any future non-run questionnaire rows*, so do NOT gate the UI on the flag;
  gate nothing client-side, the empty state costs one GET.
- **Cost safety**: no LLM anywhere in this plan; no crons; no retriggers.
- **Non-goals (v1)**: a `show_questionnaire` tool; inline mid-turn
  questionnaires outside runs; multi-operator routing; editing a question
  after promote (items are immutable — supersede instead).
- Verify: `pnpm verify` green; engine suite against a real PG
  (`RUNS_TEST_DATABASE_URL`) for the WP0 action changes; then the standing
  dogfood script on dev (`MANTLE_RUNS=1`, grant `runs` group, plan a run
  with an `ask_human` step, watch badge/flash/toast/push fire).
- Version bumps per extent at each WP (`pnpm version:bump patch`), commit
  per discrete change, no push until Jason says.
