/**
 * Runner-run observability — a thin, reusable read layer over the run records
 * DBOS persists in its system database. EVERY runner (assistant turn, Telegram,
 * future ones) shows up here automatically, so "how long did a runner run" and
 * "which runs had issues" have one answer source from day one.
 *
 * DBOS records, per run: createdAt (enqueued), dequeuedAt (a worker picked it
 * up), completedAt (finished), status, error, which process executed it, and
 * the app version. We derive the two durations operators actually want:
 *   - runMs   = completedAt - dequeuedAt  (wall-clock the runner executed)
 *   - totalMs = completedAt - createdAt   (end-to-end incl. time queued)
 */

import { DBOS, type WorkflowStatusString } from '@dbos-inc/dbos-sdk';

export type RunnerRun = {
  workflowID: string;
  /** Runner function name, e.g. 'assistantTurnWorkflow' / 'pingWorkflow'. */
  name: string;
  /** ENQUEUED | PENDING | SUCCESS | ERROR | CANCELLED | … */
  status: string;
  queue?: string;
  /** Which apps/api process executed it (helps when scaled out). */
  executorId?: string;
  appVersion?: string;
  createdAt: number;
  dequeuedAt?: number;
  completedAt?: number;
  /** Wall-clock the runner actually executed (ms). Undefined until completed. */
  runMs?: number;
  /** End-to-end latency incl. queue wait (ms). Undefined until completed. */
  totalMs?: number;
  /** Failure message when status='ERROR'. */
  error?: string;
};

type RawStatus = Awaited<ReturnType<typeof DBOS.getWorkflowStatus>>;

function toRun(s: NonNullable<RawStatus>): RunnerRun {
  const runMs =
    s.completedAt != null && s.dequeuedAt != null ? s.completedAt - s.dequeuedAt : undefined;
  const totalMs = s.completedAt != null ? s.completedAt - s.createdAt : undefined;
  const err = s.error as unknown;
  return {
    workflowID: s.workflowID,
    name: s.workflowName,
    status: s.status,
    queue: s.queueName,
    executorId: s.executorId,
    appVersion: s.applicationVersion,
    createdAt: s.createdAt,
    dequeuedAt: s.dequeuedAt,
    completedAt: s.completedAt,
    runMs,
    totalMs,
    error:
      err == null
        ? undefined
        : typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err),
  };
}

/** Recent runs, newest first. Filter by status (e.g. 'ERROR' for the issue
 *  feed) and/or time window. */
export async function listRecentRuns(opts?: {
  status?: WorkflowStatusString | WorkflowStatusString[];
  limit?: number;
  /** ISO timestamp lower bound on createdAt. */
  since?: string;
}): Promise<RunnerRun[]> {
  const rows = await DBOS.listWorkflows({
    ...(opts?.status ? { status: opts.status } : {}),
    ...(opts?.since ? { startTime: opts.since } : {}),
    limit: opts?.limit ?? 50,
    sortDesc: true,
  });
  return rows.map(toRun);
}

/** A single run by its workflow id. */
export async function getRun(workflowID: string): Promise<RunnerRun | null> {
  const s = await DBOS.getWorkflowStatus(workflowID);
  return s ? toRun(s) : null;
}
