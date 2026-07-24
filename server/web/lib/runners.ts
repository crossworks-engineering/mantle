/**
 * Server-only read + lifecycle layer for the Runners screen — Mantle's in-app
 * replica of the DBOS admin console, built on the same WorkflowStatus journal
 * DBOS keeps in its system database. This is the web-side parallel of
 * apps/api/src/runs.ts: that file reads via the runtime `DBOS.*` API inside the
 * runner process; here we read (and act) from Next.js via the cached
 * `DBOSClient` (lib/dbos-client.ts), so no DBOS HTTP admin server is needed.
 *
 * Pure types + presentation helpers live in ./runners-types (client-safe).
 */

import type { DBOSClient, WorkflowStatus, WorkflowStatusString } from '@dbos-inc/dbos-sdk';
import { RUNNER_QUEUE } from '@mantle/assistant-runtime';
import { getDbosClient } from '@/lib/dbos-client';
import type {
  RunnerListPage,
  RunnerQueueHealth,
  RunnerRun,
  RunnerRunDetail,
  RunnerStep,
} from '@mantle/web-ui/runners-types';

/** StepInfo isn't re-exported from the SDK index, so derive it from the client. */
type StepInfo = NonNullable<Awaited<ReturnType<DBOSClient['listWorkflowSteps']>>>[number];

/** Pull a human message out of DBOS's serialized error shape. */
function errorMessage(err: unknown): string | undefined {
  if (err == null) return undefined;
  if (typeof err === 'object' && 'message' in err)
    return String((err as { message: unknown }).message);
  return String(err);
}

function toRun(s: WorkflowStatus): RunnerRun {
  const runMs =
    s.completedAt != null && s.dequeuedAt != null ? s.completedAt - s.dequeuedAt : undefined;
  const totalMs = s.completedAt != null ? s.completedAt - s.createdAt : undefined;
  const queuedMs = s.dequeuedAt != null ? s.dequeuedAt - s.createdAt : undefined;
  return {
    workflowID: s.workflowID,
    name: s.workflowName,
    status: s.status,
    queue: s.queueName,
    executorId: s.executorId,
    appVersion: s.applicationVersion,
    recoveryAttempts: s.recoveryAttempts,
    createdAt: s.createdAt,
    dequeuedAt: s.dequeuedAt,
    completedAt: s.completedAt,
    updatedAt: s.updatedAt,
    runMs,
    totalMs,
    queuedMs,
    error: errorMessage(s.error),
  };
}

function toStep(s: StepInfo): RunnerStep {
  const durationMs =
    s.completedAtEpochMs != null && s.startedAtEpochMs != null
      ? s.completedAtEpochMs - s.startedAtEpochMs
      : undefined;
  return {
    functionID: s.functionID,
    name: s.name,
    durationMs,
    startedAt: s.startedAtEpochMs,
    completedAt: s.completedAtEpochMs,
    childWorkflowID: s.childWorkflowID ?? undefined,
    error: s.error ? errorMessage(s.error) : undefined,
  };
}

const PREVIEW_MAX = 4000;

/** JSON-stringify a value to a bounded preview string (input/output can be big
 *  — a full assistant turn, etc.). Returns undefined for nullish. */
function preview(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text == null) return undefined;
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}\n… (truncated)` : text;
}

export type ListRunsOpts = {
  status?: WorkflowStatusString | WorkflowStatusString[];
  /** Filter by runner function name (exact). */
  name?: string;
  /** Filter by queue name. */
  queue?: string;
  /** ISO lower bound on createdAt. */
  since?: string;
  limit?: number;
  offset?: number;
};

const DEFAULT_LIMIT = 50;

/** A page of runs, newest first. Over-fetches by one to report `hasMore`
 *  without a separate count query (DBOS exposes no count API). */
export async function listRuns(opts: ListRunsOpts = {}): Promise<RunnerListPage> {
  const client = await getDbosClient();
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 200);
  const rows = await client.listWorkflows({
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.name ? { workflowName: opts.name } : {}),
    ...(opts.queue ? { queueName: opts.queue } : {}),
    ...(opts.since ? { startTime: opts.since } : {}),
    limit: limit + 1,
    offset: opts.offset ?? 0,
    sortDesc: true,
  });
  const hasMore = rows.length > limit;
  return { runs: rows.slice(0, limit).map(toRun), hasMore };
}

/** A single run with its steps and (truncated) input/output. */
export async function getRunDetail(workflowID: string): Promise<RunnerRunDetail | null> {
  const client = await getDbosClient();
  const [statuses, steps] = await Promise.all([
    // loadInput/loadOutput pull the payloads (owner-only screen; we truncate).
    client.listWorkflows({
      workflowIDs: [workflowID],
      loadInput: true,
      loadOutput: true,
      limit: 1,
    }),
    client.listWorkflowSteps(workflowID),
  ]);
  const s = statuses[0];
  if (!s) return null;
  return {
    ...toRun(s),
    input: preview(s.input),
    output: preview(s.output),
    steps: (steps ?? []).map(toStep),
  };
}

/** Distinct runner function names seen recently — powers the name filter. */
export async function listRunnerNames(): Promise<string[]> {
  const { runs } = await listRuns({ limit: 200 });
  return [...new Set(runs.map((r) => r.name))].sort();
}

/** Queue config + live ENQUEUED / PENDING counts for the runner queue. */
export async function getQueueHealth(name: string = RUNNER_QUEUE): Promise<RunnerQueueHealth> {
  const client = await getDbosClient();
  const [queue, enqueued, pending] = await Promise.all([
    client.retrieveQueue(name).catch(() => null),
    client.listQueuedWorkflows({ queueName: name, status: 'ENQUEUED', limit: 1000 }),
    client.listQueuedWorkflows({ queueName: name, status: 'PENDING', limit: 1000 }),
  ]);
  return {
    name,
    concurrency: queue?.concurrency,
    workerConcurrency: queue?.workerConcurrency,
    rateLimit: queue?.rateLimit,
    enqueued: enqueued.length,
    pending: pending.length,
  };
}

/** Cancel an in-flight run (sets status CANCELLED; children cancelled too). */
export async function cancelRun(workflowID: string): Promise<void> {
  const client = await getDbosClient();
  await client.cancelWorkflow(workflowID, { cancelChildren: true });
}

/** Resume a halted run from its last completed step (same workflow id). */
export async function resumeRun(workflowID: string): Promise<void> {
  const client = await getDbosClient();
  await client.resumeWorkflow(workflowID);
}

/** Restart = fork from step 0 → a brand-new run from scratch. Returns the new
 *  workflow id. */
export async function restartRun(workflowID: string): Promise<string> {
  const client = await getDbosClient();
  return client.forkWorkflow(workflowID, 0);
}

/** Fork from a chosen step → a new run reusing prior steps' results. Returns the
 *  new workflow id. */
export async function forkRun(workflowID: string, startStep: number): Promise<string> {
  const client = await getDbosClient();
  return client.forkWorkflow(workflowID, startStep);
}
