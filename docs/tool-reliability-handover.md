# Handover: the tool-reliability programme — state & continuation

Written 2026-07-08 at the end of the founding session. This is the
continuation map: what shipped, how agent tool use is now reviewed, and the
open threads, so any session can pick the programme up cold. The two
standing references it builds on (read them first):

- [tool-reliability.md](tool-reliability.md) — the architecture: the
  per-call pipeline and the reliability ladder
  (**prose → schema → validating errors → gates → code**).
- `packages/tools/CLAUDE.md` — the rule book (error style guide, schema
  rules, description style guide), enforced in part by
  `packages/tools/src/description-lint.test.ts`.

Two governing principles, both operator-confirmed:
**move every rule down the ladder until it can't be ignored**, and
**mutate diagnostics, never data** (error strings are sanitized; fenced
retrieved content is never rewritten — the boundary is the defense).

## What has shipped (chronological)

| Release | What |
|---|---|
| v0.118.x | Batch-atomic volume caps; draft-aware block listing; per-agent tool budgets; edit-strategy guidance |
| v0.119.0 | The ten-item reliability release: central coerce-then-validate (`MANTLE_TOOL_VALIDATION` off/warn/enforce, default **warn**); closed builtin schemas + did-you-mean; teaching-error sweep + central error sanitizer; provenance fencing (`untrusted` flag from dispatch: http always, recipes when tainted); failure-aware guards (`repeated_failure` / `no_progress`, canonical signatures); `requiresConfirm` on outward-facing senders (new brains only — seed never re-asserts on existing rows); `registerDynamicSchema` hooks (delegate enum = first consumer); deterministic tool-outcome ledger (force-final injection + persisted `toolStats` + UI footer, `queued` counted separately from succeeded); `node_exists` preconditions; `page_blocks_apply` atomic batch editor. Adversarially audited pre-release; three defects fixed (`a8c38e84`) |
| v0.119.1 | `/debug` → **Tool validation** tab — the warn-mode telemetry made readable (mode banner, per-tool flagged table, recent flagged calls with trace links) |
| v0.120.x | Duplicate-block-id fix (editor mint bug + `ensureBlockIds` self-healing); tool-description standard + CI lint over all builtins (`40e15564`, hardened `946d922b`) |
| unreleased on main | `page_blocks_apply` **chaining id map** (`6a9f8691`): returns `created_ids` per op + `deleted_ids` so consecutive batches chain without re-listing; a bad-anchor error names ALL stale ids in the remaining ops at once. Root-caused from a live pilot-brain turn where chunked batches invalidated each other's anchors (4 failed batches, each recovered by re-list — machinery held, rounds were wasted) |

## How brain actions are reviewed now

1. **Every tool call is a trace step** (`trace_steps`): redacted input,
   output/error, duration, and skip reasons for calls a guard blocked
   (`duplicate_in_response`, caps, `repeated_failure`, `no_progress`,
   `queued_for_approval`). `/traces/<id>` shows the whole turn.
2. **Validator telemetry**: in warn mode every repair / unknown key /
   violation lands in `trace_steps.meta.arg_validation` without changing
   behaviour. Read it at **`/debug` → Tool validation** — per-tool tallies
   over a selectable window, each recent flagged call in detail, linked to
   its trace. Clean calls write nothing: it's a problem list, not a rate.
3. **The turn ledger**: when budget/iterations end a turn, the model is
   handed the runtime's own tally (succeeded / FAILED / queued / blocked)
   before answering, and the same `toolStats` persist onto the outbound
   message — the /assistant footer shows "N tool calls" with an
   always-visible notice when any failed. Replies can't paper over
   failures.
4. **Approval queue**: confirm-gated calls park in `/pending`; the ledger
   reports them as *queued*, never done.
5. **The review loop → enforce flip** (per box): let real traffic run in
   warn mode → read the Tool validation tab → *violations* are the enforce
   question; a cluster on one tool usually means OUR schema bug (fix it
   first); *repairs* are free. When the profile is model-mistakes, set
   `MANTLE_TOOL_VALIDATION=enforce` in the stack `.env` and restart.

Incident-review pattern that has worked twice: pull recent
`trace_steps` errors for the affected brain, reconstruct the exact turn
step-by-step, verify id/content provenance against the stored doc, then
move the failing rule down the ladder (the chaining id map came from
exactly this).

## Open threads (continue here)

1. **Ship the chaining id map** — tag (v0.121.0 material) + roll the pilot
   and dev boxes on the operator's word; then read the next big-edit turn's
   trace to confirm the model actually chains via `created_ids`
   (adoption is the one behavioral unknown).
2. **Enforce-flip review** — warn-mode telemetry is accumulating on two
   boxes; after a few days of traffic, run the review loop above and
   decide per box. Production is intentionally still one release behind;
   roll it after the pilot soak.
3. **Giant-page splitting** — every editing pathology this week drew its
   teeth from one ~2,000-block page; `page_split` is the designed answer
   and its description tells the agent to PROPOSE it. If edits keep
   concentrating there, drive the split.
4. **Deferred by design, triggers documented**: model-based reviewer on
   risky tools (only if deterministic guards + enforce telemetry prove
   insufficient); retrieval tool-surfacing (trigger: catalog growth —
   grants filter FIRST, selection never becomes permission).
5. **Small knowns**: `MANTLE_TOOL_VALIDATION` still absent from deployment
   docs; heartbeat builtins follow the description guide but sit outside
   the lint (dependency cycle); an `event_update` clears-omitted-fields
   handler bug was chipped off during the description sweep — check it
   landed; team-turn messages don't persist `toolStats` (separate table,
   deliberate — revisit if team usage grows).

## House workflow (unchanged)

Feature work in worktrees (`scripts/new-worktree.sh`), `--no-ff` merges
from the integrator, one commit per discrete change, version bumps + tag
pushes only on the operator's word (tag-push = publish = CI image). Every
feature session adds a Feature Tracker row and journals to the dev brain.
Operational/box specifics stay OUT of this public repo — the dev brain is
the system of record for those.
