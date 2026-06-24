# Handover — live progress feedback in specialist Assist panels

**Goal:** every specialist "Assist" chat window should show *what the agent is
doing right now* while a run is in flight — not just a blind spinner. The Apps
builder (Appsmith) now does this with a live, step-by-step label
("Writing code…", "Building…", "Reading docs…"). This handover documents that
reference implementation and the plan to roll the same enrichment out to **all**
specialist surfaces.

---

## 1. The landscape — the four specialist Assist surfaces

All four are in-surface side panels that invoke a specialist via `invokeAgent`
(a one-shot, blocking POST). Surface ⇄ default agent is derived from the
manifest's `assistSurface` field ([manifest.ts](../apps/web/lib/system-manifest/manifest.ts) →
`ASSIST_SURFACE_DEFAULTS`); the surface enum lives in
[lib/assist-agent.ts](../apps/web/lib/assist-agent.ts) (`AssistSurface =
'pages' | 'tables' | 'apps' | 'dev-tools'`).

| Surface | Agent | Panel (client) | Route | Feedback today |
|---|---|---|---|---|
| **apps** | Appsmith | [app-detail-client.tsx](../apps/web/app/(app)/apps/[id]/app-detail-client.tsx) | [ai-assist](../apps/web/app/api/apps/[id]/ai-assist/route.ts) | ✅ **live stage labels** (the new reference) |
| **pages** | Pages | [page-editor/ai-assist-panel.tsx](../apps/web/components/page-editor/ai-assist-panel.tsx) | [ai-assist](../apps/web/app/api/pages/[id]/ai-assist/route.ts) | animated "Pages is working" badge (ping + dots), **no live label** |
| **tables** | Ledger | [table-grid/table-assist-panel.tsx](../apps/web/components/table-grid/table-assist-panel.tsx) | [ai-assist](../apps/web/app/api/tables/[id]/ai-assist/route.ts) | `Loader2` spinner + "{name} is working…" |
| **dev-tools** | Toolsmith | [dev-tools/assist-panel.tsx](../apps/web/components/dev-tools/assist-panel.tsx) | [ai-assist](../apps/web/app/api/dev-tools/ai-assist/route.ts) | `Loader2` spinner + "{name} is working —" |

(The **main assistant** — `/assistant` — already has live labels via a separate
path: [use-turn-stage.ts](../apps/web/components/assistant/use-turn-stage.ts) →
[GET /api/assistant/turn/stage](../apps/web/app/api/assistant/turn/stage/route.ts) →
[lib/assistant/turn-stage.ts](../apps/web/lib/assistant/turn-stage.ts). That's
for `kind='responder_turn'` traces; specialists are `kind='manual'`.)

---

## 2. Why this generalises trivially

The enabling fact (same one the assistant's turn-stage relies on): **the tracing
layer writes the trace row (`status='running'`) and each step row — with a
descriptive `name` — at the START of the work, before it runs.** So an in-flight
run's *current* activity is already queryable mid-run with two tiny indexed reads.
No streaming refactor, no change to the blocking request/response path.

Every specialist Assist run goes through `invokeAgent`, which opens a trace with
`kind='manual'`, `subject_kind='child_agent'`, `agent_id=<the agent>`, and
`data.delegated_agent_slug=<slug>` (see
[invoke-agent.ts](../packages/agent-runtime/src/invoke-agent.ts) ~line 133). Step
names come from the tool loop: `<adapter>_chat` (an LLM call) and `tool: <slug>`
(a dispatch). So the *only* per-surface difference is the slug→label mapping —
and even that can be unified, because tool slugs are globally unique.

---

## 3. The reference implementation (Apps) — copy this shape

Four small pieces, no new dependencies, run path untouched:

1. **Stage reader** — [lib/apps/assist-stage.ts](../apps/web/lib/apps/assist-stage.ts)
   - `appStageLabelForStep(name)`: maps a step name → label (`_chat` → "Thinking…",
     `tool: app_build` → "Building…", etc.).
   - `currentAppAssistStage(ownerId)`: finds the owner's latest *running*
     `manual`/`child_agent` trace within a freshness window, reads its
     most-recently-started step, returns the mapped label (soft-fails to `null`).

2. **Stage endpoint** — [GET /api/apps/[id]/assist-stage](../apps/web/app/api/apps/[id]/assist-stage/route.ts)
   returns `{ label }`. `dynamic = 'force-dynamic'`. Owner-scoped.

3. **Poll hook** — [use-assist-stage.ts](../apps/web/components/app-sandbox/use-assist-stage.ts):
   while `active`, self-scheduling ~900ms poll (no overlap), `cache:'no-store'`,
   returns the latest label or `null`.

4. **Indicator** — `AppsmithWorking` at the bottom of
   [app-detail-client.tsx](../apps/web/app/(app)/apps/[id]/app-detail-client.tsx):
   an animated badge (`animate-ping` sparkle + bouncing dots) + the live label,
   falling back to "Appsmith is working…" between recognised steps. Wired with
   `const assistStage = useAssistStage(app.id, busy === 'assist')`.

> **Status:** this Apps implementation is currently **staged/uncommitted** along
> with the app-builder preview fixes — commit it before/with the generalisation.

---

## 4. Target design — make it shared (recommended)

Rather than copy-paste four times, extract a shared layer. One unified label map
works for all specialists because slugs don't collide.

- **`lib/assist-stage.ts` (shared)**
  - `specialistStageLabelForStep(name): string | null` — the unified map. Base
    rules (apply to every agent): `_chat` → "Thinking…"; `tool: invoke_agent` →
    "Delegating…"; `tool: web_search|web_search_pro|web_fetch` → "Reading docs…";
    `spill_result:` → "Working on it…". Then a `switch` over the per-specialist
    slugs:
    - apps: `app_file_write` → Writing code…, `app_build` → Building…,
      `app_get` → Reading the app…, `app_tools_set` → Wiring up tools…,
      `app_db_schema_set` → Setting up storage…, `app_publish` → Publishing…
    - pages: `page_blocks_list`/`page_block_get` → Reading the page…,
      `page_block_update`/`page_block_insert_after`/`page_update_draft` →
      Editing the page…, `page_block_delete` → Removing blocks…,
      `page_from_file` → Importing…, `page_split` → Splitting…
    - tables: `table_rows_list`/`table_get` → Reading the table…,
      `table_row_add`/`table_row_update`/`table_set_aggregate` → Editing the
      table…, `table_from_text`/`table_from_file` → Importing data…,
      `table_commit` → Saving…
    - dev-tools/Toolsmith: `api_tool_create`/`api_tool_update` → Writing the
      tool…, `api_tool_test` → Testing the API…, `tool_group_ensure`/
      `agent_grant_tool_group` → Granting…
    - default `tool: …` → "Working on it…"
  - `currentSpecialistStage(ownerId, agentSlug): string | null` — same two reads
    as the apps version, **but filter by the surface's agent** so concurrent runs
    don't cross-talk: `and(kind='manual', subject_kind='child_agent',
    status='running', startedAt > fresh, sql` + a `data->>'delegated_agent_slug'
    = ${agentSlug}` predicate (or filter by `agent_id` after resolving it).
    `FRESH_WINDOW_MS = 5 min` (builds run longer than chat turns).

- **One shared route** — `GET /api/assist/stage?surface=<pages|tables|apps|dev-tools>`:
  `resolveAssistAgentSlug(ownerId, surface)` → `currentSpecialistStage(ownerId,
  slug)` → `{ label }`. Avoids four near-identical routes. (Per-surface routes
  are also fine if you prefer surface-scoped URLs.)

- **Generalised hook** — `useAssistStage(url, active)` (today's hook hardcodes the
  apps URL; widen it to take the URL or a surface).

- **Shared indicator** — `<SpecialistWorking stage agentName />` (generalise
  `AppsmithWorking`; `agentName` for the "{name} is working…" fallback).

Then **migrate Apps onto the shared layer** (drop `lib/apps/assist-stage.ts`,
filter-by-slug for free) so there's one code path.

---

## 5. Rollout steps per surface

For **pages**, **tables**, **dev-tools** (apps is the template):

1. Add the surface's tool-slug labels to `specialistStageLabelForStep`.
2. In the panel, resolve the agent's display name you already show, and add:
   `const stage = useAssistStage('/api/assist/stage?surface=<s>', busy)`.
3. Replace the existing spinner/"is working" line with `<SpecialistWorking
   stage={stage} agentName={displayName} />` (keep it inside the chat message
   list for Pages/Tables/Dev so it sits where the typing dots were).
4. Leave the per-reply result UI (Pages' diff summary, etc.) exactly as-is —
   this only changes the *in-flight* state.

No route changes needed (they already `invokeAgent`). No agent/prompt/manifest
changes — this is pure UI + a read-only trace query.

---

## 6. Gotchas & decisions

- **Filter by agent slug.** The apps reader takes "the latest running
  manual/child_agent trace," which is fine in isolation but would cross-talk if
  two surfaces polled at once. The shared `currentSpecialistStage` MUST filter by
  the surface's resolved agent slug. (This also future-proofs against the main
  assistant delegating to a specialist in the background.)
- **Coarse on purpose.** Fast CRUD tools flash by under the ~900ms poll; only
  name stages a user actually waits on. Unrecognised step → `null` → the panel
  shows the "{name} is working…" fallback (never a blank).
- **Soft-fail to null.** A tracing hiccup must never break the panel — wrap the
  reads in try/catch returning `null` (as the apps + assistant readers do).
- **Freshness window** guards a zombie `status='running'` trace from showing a
  stale label forever (a past failure mode the assistant reader hit).
- **Polling cost over Tailscale.** The dev frontend talks to the remote core over
  Tailscale, so each poll round-trips. Two indexed single-row reads at ~1×/s is
  cheap; the self-scheduling timer (next poll only after the last resolves)
  prevents pile-ups when latency is high. Labels lag by the round-trip — fine.
- **Chat vs single-reply panels.** Pages/Tables/Dev are multi-bubble chat
  surfaces; Apps shows a single reply. The indicator slots into either — render
  it where the pending state currently shows.
- **Step naming contract.** Labels depend on step names from
  [tool-loop.ts](../packages/agent-runtime/src/tool-loop.ts) (`tool: <slug>`,
  `<adapter>_chat`). If that naming changes, update the mappers (there's no
  compile-time link — consider a tiny test asserting a few slugs map).

---

## 7. Checklist

- [ ] Commit the staged Apps feedback (reference impl) + preview fixes.
- [x] Extract `lib/assist-stage.ts` (`specialistStageLabelForStep` +
      `currentSpecialistStage(ownerId, agentSlug)`, slug-filtered via
      `data->>'delegated_agent_slug'`).
- [x] Add `GET /api/assist/stage?surface=…` (one shared, surface-validated route).
- [x] Generalise the hook → `useAssistStage(url, active)` (now in
      `components/specialist-working.tsx`).
- [x] Extract `<SpecialistWorking stage agentName />` (same file).
- [x] Migrate Apps onto the shared layer (old `lib/apps/assist-stage.ts`,
      `app-sandbox/use-assist-stage.ts`, and `/api/apps/[id]/assist-stage`
      deleted; `AppsmithWorking` removed).
- [x] Wire Pages, Tables, Dev-tools panels.
- [x] Fill the per-specialist slug→label maps (verified against each agent's
      real tool list in `packages/tools/src/builtins-*`).
- [x] `pnpm --filter @mantle/web run typecheck` (clean) + `assist-stage.test.ts`
      asserts the step-name contract. Remaining: manual sanity on each surface
      (run an edit, watch the label change through read/edit/build/etc.).

**Effort:** ~half a day. It's mechanical once the shared layer exists — the
trace infrastructure already does the hard part.
