# Addendum — audit items #2–#6 implemented (2026-07-17)

Continuation of [handover-audit-2026-07.md](handover-audit-2026-07.md). Everything
under its "What's left" section **except #1 (ops alerting)** is now implemented on
`feat/audit-fixes` — 16 commits on top of `7ff039cd` (v0.140.0). Gates green at
every commit: typecheck clean, ESLint **0 errors / 0 warnings (ratcheted to
`error`)**, Prettier clean, **2290 tests** (was 2161). Still NOT merged, NOT
pushed, NOT released. Item #1 is parked in dev-brain task `b297af94` pending
Jason's design; the audit running log `de19ce14` is updated to match.

## What landed

| Commit                             | Item | Summary                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `230ebe7c`                         | #2   | Backup-location footgun closed: custom locations that resolve into the container's ephemeral overlay FS are rejected at save time (400) and at run time (ok:false with a plain-English error) — `/proc/self/mounts` detection, fail-open outside containers. `minio`/`mc`/`ollama` pinned (env-overridable, tailscale pattern). Heartbeat-file liveness probes on `api` + all 8 workers (`x-worker-healthcheck` anchor; helper in `packages/content/src/process-heartbeat.ts`). `mem_limit` guardrails on long-runners; postgres deliberately uncapped. |
| `f535e2b6`                         | #3   | Page drafts get optimistic concurrency, mirroring tables: `pages.draft_rev` (migration **0122**), `if_rev` on draft/commit → **409** with `current_rev` on staleness, `withPageLock` (`FOR UPDATE`) serializes agent-side writers, client stops autosaving + reloads on conflict. Applied 0122 to the local 54323 dev DB.                                                                                                             |
| `e2e5eede`                         | #4   | Lint backlog 78 → 0: 61 dead-code deletions, 9 hook-dep warnings properly fixed (useMemo/useCallback), 4 intentional omissions made explicit with reasons, 4 `any`s typed. `no-unused-vars`, `exhaustive-deps`, `no-explicit-any` now `error` in CI. Type-aware rules remain the documented follow-up.                                                                                                                              |
| `c2404696`                         | #5   | `str`/`strArr` centralized to `packages/tools/src/coerce.ts` (29 copies; `strArr` had forked into 4 behaviors — two genuinely divergent ones kept local + documented). `slugify` centralized to `apps/web/lib/slugify.ts` (10 copies, 6 behaviors) with option profiles; **byte-identical output at every load-bearing site**, verified by regression tests against each legacy body.                                                 |
| `37a80030`                         | #5   | `extractNode` decomposed: ~1,266 lines → 377-line orchestrator over 9 verbatim-moved stage functions (same file, same trace closure). Zero behavior change; stages are now individually callable for future targeted tests.                                                                                                                                                                                                        |
| `0e18bab9` `1f09a697` `4a08a3fb`   | #5   | Telegram unification, staged (wholesale reroute through `runAssistantTurn` was assessed and **rejected** — delivery/persistence models are deliberately sibling, matching the `run-team-turn` precedent): 14 characterization tests first; then shared `assembleResponderTurn` (`packages/assistant-runtime/src/assemble-turn.ts`) — **fixing two real drift bugs Telegram had missed: `max_iterations`/tool-volume clamps and image retry-after-error**; then a single traced-loop core (`responder-loop.ts`) used by web, team, and telegram. Telegram also gains the empty-reply fallback (no more silent turns) and now persists thought trails + toolStats like web. Zero parallel orchestration remains in `apps/api/src/agent/runtime.ts`. |
| `10f03cce`                         | #6   | Microsoft + calendar sync coverage (+51 tests): ICS recurrence/cancelled/malformed/timezones, full-set-deletion-by-absence vs delta-deletion-by-cancellation semantics, drive-item classify (skip/remove/ingest — new pure seam `drives/classify.ts`), Graph paging/deltaLink cursor, 429 retry budget, mail watermark + normalization. No real bugs found; `removeItem`'s DB internals flagged as the next integration-test target. |

## Post-review fixes (2026-07-17, same day)

A three-reviewer adversarial pass over `54db9ae3..HEAD` (new logic / refactor
drift / runtime unification) found the refactors provably drift-free and the
unification clean, plus 2 majors + 5 minors — all fixed:

| Commit     | Fix                                                                                                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `6f5d6dd9` | **autoheal sidecar** (`willfarrell/autoheal:1.2.0`, pinned) — plain Compose never restarts `unhealthy` containers, so the heartbeat probes were observability-only; the sidecar restarts the 9 labeled services (api + 8 workers). Same docker.sock mitigations as the updater. |
| `01a7c0e5` | **draft_rev threaded through agent page writers** — the four block-op tools now pass their read's rev as `baseRev`; a conflict returns a teaching tool-error (re-read, re-apply) instead of clobbering a concurrent user edit. Wholesale-replace tools stay unconditional by design. |
| `eb958135` | **Review minors** — backup guard also rejects `tmpfs`/`ramfs` and resolves symlinks (fail-open); worker mem caps doubled 512m → 1g (large-file OOM headroom); pages client pauses autosave after a 409 until the reload reseeds (no toast spam, no stale-rev refiring); Team Chat clamp inheritance documented. |

Suite after fixes: **2,293 tests**, all gates green. Note: `team-chat-auth.test.ts`
showed the same parallel-load timeout flake class as `app-build/build.test.ts`
(passes isolated) — the flaky-timeout class is worth a follow-up bump.

## Deploy caveats (supersedes the original list)

1. **`docker-compose.yml` changed substantially** (healthcheck anchor, mem
   limits, image pins, plus the original worker_events mounts + x-logging) —
   tag-only `registry-pull` boxes need a **compose refresh** (memory
   `mantle-deploy-compose-drift`).
2. **Migrations 0121 + 0122** — forward-only, tiny locks; back up first per the
   usual gate. Both already applied to the local dev DB (54323).
3. **Perf verification was on the small local clone** — re-check EXPLAIN plans
   on a large corpus after deploy (unchanged from original).
4. **Telegram responder must be smoke-tested live before shipping** (dev →
   DFM → NATREF):
   - text turn + a >4096-char answer (one Telegram message per chunk, threads
     under the inbound);
   - voice note in → voice reply out; a `[VOICE]`-provoking typed turn;
   - photo with and without caption + a PDF (file node in /files, inline
     answer; an oversized/odd image should now **retry text-only instead of
     killing the turn** — new behavior);
   - an agent with `memory_config.max_iterations` configured — **now enforced
     on Telegram for the first time**; agents with large configured values may
     run longer/cost more per turn than before;
     - Same inheritance applies to **Team Chat**: `runTeamTurn` now spreads
       `assembled.loopOverrides`, so a `team-responder` agent's
       `memory_config.max_tool_calls` / `max_calls_per_tool` clamps are enforced
       where they previously weren't. Safe direction (tighter caps), and inert
       unless those keys are configured — no behavior change on stock brains.
   - the empty-reply fallback message where Telegram used to go silent;
   - /traces on a telegram turn (`load_context` → `build_messages` → loop →
     `send_telegram` → `persist_outbound`), thought trail + tool stats visible
     when thoughts-persistence is on;
   - one web /assistant turn + one Team Chat turn to confirm the shared core
     left the other surfaces intact.
5. Known flake: `app-build/build.test.ts` can exceed its 5s timeout under full
   parallel suite load (passes in ~330ms isolated). Pre-existing, unrelated.

## What's still open

- **#1 ops alerting** — dev-brain task `b297af94`, awaiting Jason's design.
- Session revocation (`token_version`) and shared-store rate limiting — tracked
  in `de19ce14`, deliberately out of this handover's scope.
- ESLint type-aware rules (`no-floating-promises`, `no-misused-promises`) once
  the ratcheted gate has settled.
- Integration harness for destructive DB paths (`removeItem` internals).

## Suggested next move

Unchanged in shape: review the branch (`/code-review`), merge `--no-ff` from the
integrator, cut a release — then compose-refresh the boxes and run the Telegram
smoke list above on dev before DFM/NATREF pick it up.
