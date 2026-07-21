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

/**
 * DBOS workflow names — the cross-runtime contract for slice 3's turn
 * execution (plan §4 WP1/WP2). The apps/api runner REGISTERS these; the runs
 * worker ENQUEUES them by name via DBOSClient after winning the claim CAS.
 * DBOS is deliberately NOT imported here (the assistant-runtime contract.ts
 * idiom) — callers pass the strings to the DBOS APIs themselves.
 *
 * workflowID convention: `<itemId>:<attempt>` — unique per SEMANTIC attempt
 * (a retry must not dedupe against the previous attempt's workflow), still
 * deterministic from the item row for observability (`getRun('<id>:<n>')`,
 * no listWorkflows archaeology).
 */
export const RUNS_WORKER_TURN_WORKFLOW = 'runsWorkerTurnWorkflow';

/** Serializable input the worker-turn workflow journals. Ids only — the
 *  table is the truth, the workflow re-reads state (jobs-carry-only-ids,
 *  §5b, applied to DBOS enqueues too). */
export type RunsWorkerTurnInput = { itemId: string };

/** Serializable result (journaled). Small on purpose — outcomes live on the
 *  item row; this is for the run record / debugging only. */
export type RunsWorkerTurnResult = {
  executed: boolean;
  /** Terminal state driven, 'retry' when requeued, or the skip reason. */
  outcome: 'done' | 'failed' | 'retry' | 'stale' | 'disabled';
};

/**
 * Resume turns (WP2). No workflowID convention here — a resume workflow that
 * errors WITHOUT claiming must be re-enqueueable by the sweep's re-send, and
 * a fixed id would dedupe the rescue into a no-op (ON CONFLICT never resets
 * a terminal row). Instead: `deduplicationID = groupId` (one QUEUED resume
 * per group at a time; clears when it starts) + the `resumed_at` CAS as the
 * at-most-once turn gate, exactly as before.
 */
export const RUNS_RESUME_TURN_WORKFLOW = 'runsResumeTurnWorkflow';

export type RunsResumeTurnInput = { runId: string; groupId: string };

export type RunsResumeTurnResult = {
  resumed: boolean;
  outcome: 'reported' | 'audited' | 'duplicate' | 'precondition' | 'disabled';
};
