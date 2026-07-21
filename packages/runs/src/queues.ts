/**
 * pg-boss queue names for the runner engine ("the table is the truth; pg-boss
 * jobs are disposable wake-ups"). Named after the repo's `mantle.` convention
 * (see workers/maintenance.ts) — the design doc's `run.tool` etc. carry the
 * same split:
 *
 * - tool queue: `tool_call` / `note` leaves — fast, higher team size.
 * - worker queue: `worker_invoke` leaves — each job is a whole agent turn
 *   (slice 2); team size = the global concurrency cap, the per-run cap is
 *   enforced at promotion time.
 * - resume queue: responder resume turns, `singletonKey = group id` (the
 *   double-fire backstop), low concurrency.
 *
 * Jobs carry ONLY `{ itemId }` / `{ runId, groupId }` — never payload.
 * Duplicates no-op via the engine's CAS transitions; losses are healed by the
 * sweep.
 */
export const RUN_TOOL_QUEUE = 'mantle.run.tool';
export const RUN_WORKER_QUEUE = 'mantle.run.worker';
export const RUN_RESUME_QUEUE = 'mantle.run.resume';
