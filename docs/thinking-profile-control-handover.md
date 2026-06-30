# Handover — per-user thinking control (switch + budget) in Profile

**Status:** investigation complete, **no code written yet**. Pick up here.
**Worktree:** `.claude/worktrees/thinking-profile-control` — branch `feat/thinking-profile-control` (forked from `main`, clean). Do the work HERE, not the integrator.
**Date:** 2026-06-30.

## The ask (Jason, verbatim)

> "Lets still utilise the switch but add the thinking budget with it, both have to have on and a value before working."

Translate: the existing **"Live thinking & streaming"** switch (`streamThoughts`) + a **new per-user "Thinking budget" value**. Real model thinking is requested **only when the switch is ON _and_ the budget > 0**. This moves the thinking gate from the per-box env var `MANTLE_THINKING_BUDGET` to a **per-user profile preference**.

## Background (already on `main`, v0.99.0)

The whole real-thinking pipeline + GitHub Copilot provider is merged + released (see `docs/hermes-thinking-and-providers-handover.md`). Today thinking is gated DARK by **env `MANTLE_THINKING_BUDGET`**, read in `packages/agent-runtime/src/tool-loop.ts` via `resolveThinkingBudget()` (env-based). **This task replaces that env gate with the per-user profile gate.**

## Correction worth knowing

`streamThoughts` is **NOT a no-op** (an earlier claim in this thread was wrong). It's consumed via the `isStreamThoughtsEnabled(prefs)` helper in the **server turn routes** — so it already gates the live *display*:
- `apps/web/app/api/assistant/turn/route.ts:297` — `isTurnStreamingEnabled() && isStreamThoughtsEnabled(await loadProfilePreferences(user.id))` → 202-stream vs blocking.
- `apps/web/app/api/assistant/turn/[turnId]/stream/route.ts:52` — SSE route 404s when off (client falls back to poll).

⇒ The switch already controls the streaming display. **We only need to add the thinking-REQUEST gate.** No client-side gating to add.

---

## Implementation plan (6 files)

### 1. `packages/content/src/profile-preferences.ts`
- Add to the `ProfilePreferences` type (near `streamThoughts`/`thoughtTrailMode`, ~line 143):
  ```ts
  /** Per-user thinking budget in tokens. Real model reasoning is requested only
   *  when the live-thinking switch is ON (streamThoughts) AND this is > 0. 0 /
   *  unset = no thinking. Maps to the provider's knob in the adapters (Anthropic
   *  adaptive, OpenRouter reasoning.max_tokens, Gemini thinkingConfig, Copilot
   *  reasoning_effort). */
  thinkingBudget?: number;
  ```
- Add helper after `isStreamThoughtsEnabled` (~line 156):
  ```ts
  /** Effective per-turn thinking budget — gated by BOTH the live-thinking switch
   *  AND a positive value. 0 when either is missing. */
  export function resolveThinkingBudget(
    prefs: Pick<ProfilePreferences, 'streamThoughts' | 'thinkingBudget'>,
  ): number {
    if (!isStreamThoughtsEnabled(prefs)) return 0;
    const b = prefs.thinkingBudget;
    return typeof b === 'number' && b > 0 ? Math.floor(b) : 0;
  }
  ```
  ⚠️ Name `resolveThinkingBudget` collides with the env one in `tool-loop.ts` — that env one is being DELETED (step 4), so no conflict after.
- Add a test in `profile-preferences.test.ts` (switch off → 0; switch on + budget 0/unset → 0; switch on + budget>0 → budget).

### 2. `apps/web/app/api/profile/route.ts`
- zod schema (~line 52): add `thinkingBudget: z.number().int().min(0).max(64000).optional(),`
- destructure (~line 74) + pass to `updateProfilePreferences` (~line 102): `...(thinkingBudget !== undefined ? { thinkingBudget } : {}),`
- GET already returns the full `preferences`, so `defaults.thinkingBudget` reaches the UI — no GET change.

### 3. `apps/web/app/(app)/settings/profile/profile-client.tsx`
- `Select` is already imported (`@/components/ui/select`).
- State (~line 113, beside `replaceTrail`): `const [thinkingBudget, setThinkingBudget] = useState<number>(defaults.thinkingBudget ?? 0);`
- UI: add a "Thinking budget" sub-option inside the sub-options block (after `persistThoughts`, ~line 394+), mirroring the `replaceTrail`/`persistThoughts` pattern — `Label` with `className={cn(!streamThoughts && 'opacity-50')}` + a `Select` `disabled={!streamThoughts}`. Tiers → token values:
  - Off `0`, Low `1024`, Medium `4096`, High `16000`.
  - Select values are strings; store the numeric token value (`onValueChange={(v) => setThinkingBudget(Number(v))}`, `value={String(thinkingBudget)}`).
  - Helper text: "How hard the model reasons before answering. Needs live thinking ON and a budget above Off. Off = no extra thinking."
- Save body (~line 170, beside `thoughtTrailMode`): add `thinkingBudget,`.

### 4. `packages/agent-runtime/src/tool-loop.ts`
- DELETE the env-based `resolveThinkingBudget()` function + its doc (~lines 66–85).
- Add to `ToolLoopArgs` (~after `resultHandling`, line 232): `thinkingBudget?: number;` (doc: pre-resolved by the caller from the owner's prefs; already gated by switch+value).
- In `chatOpts` (~line 462): replace `const thinkingBudget = resolveThinkingBudget();` with `const thinkingBudget = args.thinkingBudget ?? 0;`. Everything else (drop sampling params when >0, etc.) stays.

### 5. `packages/assistant-runtime/src/run-turn.ts`
- Already imports `loadProfilePreferences` + `isStreamThoughtsEnabled` (lines 57–58) and loads `prefs` at line 371.
- Add `resolveThinkingBudget` to that `@mantle/content` import.
- At the `runToolLoop({...})` call (~lines 605–635) add: `thinkingBudget: resolveThinkingBudget(prefs),` (reuse the already-loaded `prefs`).

### 6. `packages/agent-runtime/src/invoke-agent.ts` — delegated specialists (OPEN QUESTION)
- `invoke-agent.ts:158` calls `runToolLoop` for the child. To let delegated specialists inherit thinking it needs the budget.
- `agent-runtime` does **not** currently import `@mantle/content` (grep was empty), so calling `loadProfilePreferences` there adds a new dep (check for a cycle — content almost certainly doesn't depend on agent-runtime, so probably fine, but verify package.json).
- **PREFERRED:** thread the parent's budget down instead of re-loading prefs. The `invokeAgent` handler (`async ({ ownerId, depth, ... })`, invoke-agent.ts:46) is dispatched by the tool-loop, which has `args.thinkingBudget`. Find where the tool-loop calls the AgentInvoker (grep around tool-loop.ts:719 where `ownerId: args.ownerId` is passed into the handler bridge), add `thinkingBudget: args.thinkingBudget` to that call + to the `AgentInvoker` param type, and forward it in invoke-agent's `runToolLoop({...})` call.
- **FALLBACK (acceptable for v1):** leave specialists at budget 0 (no thinking). The responder — the main path — works regardless. Don't block on this.

---

## Env gate disposition
- Drop the env `MANTLE_THINKING_BUDGET` read from `tool-loop.ts` (now per-user). This also dissolves the earlier "must add a compose passthrough" gap — no longer needed.
- Update `docs/hermes-thinking-and-providers-handover.md` §6: thinking is enabled **per user in Settings → Profile** (switch ON + budget), not via env.

## Still-required streaming carriers (unchanged, default ON)
The switch+budget only controls the thinking **request**. For reasoning to STREAM to the UI you still need the carriers on (they default on):
- `MANTLE_TURN_TOKENS` (apps/api) — installs the delta observer; if `=0` the loop uses non-streaming `chat()` and NO reasoning streams.
- `MANTLE_TURN_STREAMING` (apps/web) — the SSE master gate.

## Verify
- typecheck: `@mantle/content`, `@mantle/agent-runtime`, `@mantle/assistant-runtime`, `@mantle/web`.
- tests: `pnpm exec vitest run packages/content packages/agent-runtime packages/voice` (+ new resolveThinkingBudget test).
- browser: Settings → Profile shows "Thinking budget" under the switch, greys out when the switch is off; set switch ON + Medium, run a turn that calls a tool, confirm the collapsible "Thinking" trace populates and no 400 on round 2.
- The live OpenRouter→Anthropic signature round-trip (thinking + tools) is still only provable live — same pending smoke test as the parent work.

## Key file:line map (from this investigation)
```
packages/content/src/profile-preferences.ts
  :125 streamThoughts field   :152 isStreamThoughtsEnabled   :174 DEFAULT_PREFERENCES
  :182 loadProfilePreferences   :360 updateProfilePreferences
apps/web/app/api/profile/route.ts            :52 zod schema  :74 destructure  :102 save  :24 GET
apps/web/app/(app)/settings/profile/profile-client.tsx
  :28 Select import  :113 replaceTrail state  :170 save body  :346-394 streaming section + sub-options
packages/agent-runtime/src/tool-loop.ts
  :66-85 env resolveThinkingBudget (DELETE)  :175 ToolLoopArgs  :207 ownerId  :462 chatOpts thinkingBudget
packages/assistant-runtime/src/run-turn.ts   :57-58 content imports  :371 prefs loaded  :605 runToolLoop call
packages/agent-runtime/src/invoke-agent.ts   :46 invokeAgent handler  :158 child runToolLoop call
apps/web/app/api/assistant/turn/route.ts:297 / .../[turnId]/stream/route.ts:52  (streamThoughts already gates display)
```
