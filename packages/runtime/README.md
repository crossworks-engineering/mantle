# @mantle/runtime

Proactive agent loop: scheduled, stateful **skill→agent→surface**
triggers that let an agent act *without being prompted*.

**Canonical doc:** [`docs/heartbeats.md`](../../docs/heartbeats.md)
covers the data model, lifecycle, gates, conventions, soft-fail
catalog, and the worked `get_to_know_user` example. Start there.

This README is the package quick-reference: what's in this directory,
where to extend, where the tests live.

## Module map

| File | Purpose |
|---|---|
| `schedule.ts` | `computeNextFireAt`, `validateSchedule`. Pure functions over `HeartbeatScheduleSpec`. |
| `gates.ts` | `checkGates` — idle / quiet hours / cooldown / earliest_at. Reads from DB (telegram lookups + profile prefs). `isInsideWindow` is exported for direct testing. |
| `context.ts` | AsyncLocalStorage for the currently-firing heartbeat. Carries `slug` + `depth` for the recursion guard. |
| `inflight.ts` | Per-process `Map<id, Promise>` lock. `runWithInflightLock` + `isFireInflight`. Stops a slow fire from being re-fired by the next tick. |
| `prompt.ts` | `buildHeartbeatPrompt` (synthetic fire prompt) + `buildOpenHeartbeatContext` (3-branch awareness block). Plus `lastAskedAgo` helper. |
| `fire.ts` | Single-fire orchestration. `forceFire` / `tickFire`. Inflight-locked, snooze-preserving, trace-integrated. |
| `tick.ts` | Tick-loop driver + `openHeartbeatsForSurface` (for awareness block) + `hasActiveHeartbeatsOnSurface` (for tool auto-exclusion). |
| `tools.ts` | The 5 builtin control tools (`heartbeat_*`). Dual-mode addressing. Refuses self-recursion + depth-caps chained fires. |
| `index.ts` | Public surface re-exports. |

## Public API quick-reference

```ts
import {
  // Engine entry points
  tickHeartbeats,           // call on a setInterval from your runtime
  forceFire,                // bypass gates (UI Fire-now button + heartbeat_fire tool)

  // Builtin tool registration (call once at boot)
  registerHeartbeatTools,
  HEARTBEAT_TOOLS,          // the 5 tool definitions
  HEARTBEAT_RESPONDER_TOOLS,// canonical list of the 3 continuity tools (for auto-exclusion)

  // Responder integration
  openHeartbeatsForSurface,    // returns heartbeats with state.expecting_reply truthy
  hasActiveHeartbeatsOnSurface,// boolean; powers the per-turn tool-list trim
  buildOpenHeartbeatContext,   // 3-branch awareness block

  // Schedule + gates (used by lib + UI form)
  computeNextFireAt,
  validateSchedule,
  checkGates,
  isInsideWindow,           // pure quiet-hours window check (exported for testing)

  // Context + recursion
  withHeartbeatContext,     // ALS for the firing heartbeat
  currentHeartbeat,         // read inside a tool handler
  MAX_HEARTBEAT_DEPTH,      // cap for chained heartbeat_fire
} from '@mantle/runtime';
```

## Testing

Pure-logic test files live next to their sources:

- `schedule.test.ts` (24 tests) — every `computeNextFireAt` kind, jitter determinism + magnitude bound, `notBefore` floor, `validateSchedule` edges, `cron` throws.
- `gates.test.ts` (13 tests) — `isInsideWindow` same-day, cross-midnight, inclusive-from/exclusive-to, timezone honoured (not UTC, not process locale).
- `prompt.test.ts` (24+ tests) — both builders: state JSON inclusion, fire numbering, 3-branch decision tree, stale-pending nudge, `asked Nh ago` rendering.
- `tools.test.ts` (17+ tests) — addressing dual-mode (slug or ALS), patch shape validation, recursion guards (self + depth), registry shape, `HEARTBEAT_RESPONDER_TOOLS` pinning + filter behaviour.
- `inflight.test.ts` — exclusion + serialisation + error pass-through.

Total ~85+ tests. Run from repo root:

```bash
pnpm test
```

The DB-touching parts (`fire.ts` orchestration, `tick.ts` queries) are exercised end-to-end on the dogfood install + are deliberately not covered by unit tests — see audit `NEW-2` in [`docs/heartbeats.md`](../../docs/heartbeats.md) §7 for the rationale.

## Dev tips

- **`tsx --watch` doesn't reliably reload workspace packages.** After editing files in this package, restart `apps/agent` manually (Ctrl-C the dev process and `pnpm dev:agent`). Documented in `docs/heartbeats.md` §7.
- **Diagnostic CLI for in-process fire**: `apps/web/scripts/test-fire-heartbeat.ts` — runs `forceFire` from a fresh node process, prints state-before/after. Useful for confirming a code change works correctly when the long-running agent is suspect.
- **`tools.ts` carries silent diagnostic `setMeta`** on every branch path of the 3 mutation tools. View on `/traces` step rows to debug failed calls.

## Dependency direction

```
@mantle/runtime
  ├─ depends on: @mantle/runtime, @mantle/tools, @mantle/tracing,
  │              @mantle/api-keys, @mantle/content, @mantle/telegram,
  │              @mantle/db
  └─ depended on by: apps/agent, apps/web
```

Notably **not** a circular: heartbeats depends on `@mantle/tools`
(for `BuiltinToolDef` + `registerBuiltin`), and the heartbeat-control
tools live here in this package rather than in `@mantle/tools` to
preserve that direction. See `docs/heartbeats.md` §4 for the
rationale.
