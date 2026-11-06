/**
 * Server-only read + lifecycle layer for the Runners screen — Mantle's in-app
 * replica of the DBOS admin console, built on the same WorkflowStatus journal
 * DBOS keeps in its system database. This is the web-side parallel of
 * server/api/src/runs.ts: that file reads via the runtime `DBOS.*` API inside the
 * runner process; here we read (and act) from Next.js via the cached
 * `DBOSClient` (lib/dbos-client.ts), so no DBOS HTTP admin server is needed.
 *
 * Pure types + presentation helpers live in ./runners-types (client-safe).
 */

import type { DBOSClient, WorkflowStatus, WorkflowStatusString } from '@dbos-inc/dbos-sdk';
import {
  ASSISTANT_TURN_WORKFLOW,
  RUNNER_QUEUE,
  TEAM_TURN_WORKFLOW,
} from '@mantle/runtime/assistant';
import { getDbosClient } from '@/lib/dbos-client';
import { defineDomainError } from '@mantle/std';
import { isRunnerEngineAbsent } from './runners-engine';
import type {
  RunnerListPage,
  RunnerQueueHealth,
  RunnerRun,
  RunnerRunDetail,
  RunnerStep,
} from '@mantle/client-types/runners-types';

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

/** The text fields of a turn's rows and reply, dropped where a run is shown
 *  to someone else. */
function noText(row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const {
    text: _text,
    displayText: _display,
    imageTranscript: _transcript,
    ...kept
  } = row as Record<string, unknown>;
  return kept;
}

/** A run's input without the turn's text (its options' too). */
function inputNoText(input: unknown): unknown {
  const args = Array.isArray(input) ? input : [input];
  const out = args.map((a) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return a;
    const { text: _text, options, ...rest } = a as Record<string, unknown>;
    return { ...rest, ...(options !== undefined ? { options: noText(options) } : {}) };
  });
  return Array.isArray(input) ? out : out[0];
}

/** The login a turn's run serves (its input's options.loginId), or null. */
function runLogin(input: unknown): string | null {
  const first = Array.isArray(input) ? input[0] : input;
  const login = (first as { options?: { loginId?: unknown } } | null)?.options?.loginId;
  return typeof login === 'string' ? login.toLowerCase() : null;
}

/**
 * A run's input and output as the Runners screen shows them to `viewer`
 * (docs/agent-ui.md). A turn whose text may quote what only its login reads
 * shows no inbound, outbound or reply text to anyone but that login: a team
 * turn always (its reply may be used_private; its workflow returns ids and
 * status only, and a run recorded before carries `reply` and the rows'
 * `text`, dropped here), and an owner-engine turn that used a ui tool (it
 * saw the person's window: `usedUi`). Every other run is shown as it is.
 */
export function runShown(
  workflowName: string,
  input: unknown,
  output: unknown,
  viewerLoginId: string | null,
): { input: unknown; output: unknown } {
  const ui =
    workflowName === ASSISTANT_TURN_WORKFLOW &&
    (output as { usedUi?: unknown } | null)?.usedUi === true;
  if (workflowName !== TEAM_TURN_WORKFLOW && !ui) return { input, output };
  const own = viewerLoginId !== null && runLogin(input) === viewerLoginId.toLowerCase();
  if (own) return { input, output };
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { input: inputNoText(input), output };
  }
  const { reply: _reply, inbound, outbound, ...rest } = output as Record<string, unknown>;
  return {
    input: inputNoText(input),
    output: {
      ...rest,
      ...(inbound !== undefined ? { inbound: noText(inbound) } : {}),
      ...(outbound !== undefined ? { outbound: noText(outbound) } : {}),
    },
  };
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

/** Warn once per process, so an unprovisioned engine is visible in the log
 *  without a line per poll — the Runners screen polls. */
let warnedAbsent = false;
function noteEngineAbsent(where: string, err: unknown): void {
  if (warnedAbsent) return;
  warnedAbsent = true;
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(
    `[runners] DBOS system database unavailable (${where}: ${msg}) — ` +
      'the Runners screen will read as empty. Expected when runners were never ' +
      'provisioned or the app connects read-only; investigate if runs are meant to work here.',
  );
}

/** A page of runs, newest first. Over-fetches by one to report `hasMore`
 *  without a separate count query (DBOS exposes no count API). */
export async function listRuns(opts: ListRunsOpts = {}): Promise<RunnerListPage> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 200);
  try {
    return await listRunsUnguarded(opts, limit);
  } catch (err) {
    if (!isRunnerEngineAbsent(err)) throw err;
    noteEngineAbsent('listRuns', err);
    return { runs: [], hasMore: false, engineAvailable: false };
  }
}

async function listRunsUnguarded(opts: ListRunsOpts, limit: number): Promise<RunnerListPage> {
  const client = await getDbosClient();
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
export async function getRunDetail(
  workflowID: string,
  /** The login reading the screen: a turn's own login reads its text
   *  (runShown). */
  viewerLoginId: string | null = null,
): Promise<RunnerRunDetail | null> {
  try {
    return await runDetailUnguarded(workflowID, viewerLoginId);
  } catch (err) {
    if (!isRunnerEngineAbsent(err)) throw err;
    noteEngineAbsent('getRunDetail', err);
    return null; // the route renders this as 404, which is the truth: no such run here
  }
}

async function runDetailUnguarded(
  workflowID: string,
  viewerLoginId: string | null,
): Promise<RunnerRunDetail | null> {
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
  const shown = runShown(s.workflowName, s.input, s.output, viewerLoginId);
  return {
    ...toRun(s),
    input: preview(shown.input),
    output: preview(shown.output),
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
  try {
    return await queueHealthUnguarded(name);
  } catch (err) {
    if (!isRunnerEngineAbsent(err)) throw err;
    noteEngineAbsent('getQueueHealth', err);
    return { name, enqueued: 0, pending: 0, engineAvailable: false };
  }
}

async function queueHealthUnguarded(name: string): Promise<RunnerQueueHealth> {
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

/**
 * The run engine refused an action on a run: the run is not there, or not in
 * a state for it (DBOS's own error, `dbosErrorCode` set, with a message about
 * the workflow, never SQL). The Runners screen shows that message; the route
 * says it as a 500. A fault of
 * the engine's database is no DBOSError and answers the opaque 500.
 */
export class RunActionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunActionError';
  }
}

defineDomainError(RunActionError, {
  reason: "the run engine refused the action on this run; its message says why (the route's 500)",
  status: 500,
});

/** `fn`, with the engine's refusal of the action as a RunActionError. */
async function runAction<T>(fn: (client: DBOSClient) => Promise<T>): Promise<T> {
  const client = await getDbosClient();
  try {
    return await fn(client);
  } catch (err) {
    if (
      err instanceof Error &&
      typeof (err as { dbosErrorCode?: unknown }).dbosErrorCode === 'number'
    ) {
      throw new RunActionError(err.message, { cause: err });
    }
    throw err;
  }
}

/** Cancel an in-flight run (sets status CANCELLED; children cancelled too). */
export async function cancelRun(workflowID: string): Promise<void> {
  await runAction((client) => client.cancelWorkflow(workflowID, { cancelChildren: true }));
}

/** Resume a halted run from its last completed step (same workflow id). */
export async function resumeRun(workflowID: string): Promise<void> {
  await runAction((client) => client.resumeWorkflow(workflowID));
}

/** Restart = fork from step 0 → a brand-new run from scratch. Returns the new
 *  workflow id. */
export async function restartRun(workflowID: string): Promise<string> {
  return runAction((client) => client.forkWorkflow(workflowID, 0));
}

/** Fork from a chosen step → a new run reusing prior steps' results. Returns the
 *  new workflow id. */
export async function forkRun(workflowID: string, startStep: number): Promise<string> {
  return runAction((client) => client.forkWorkflow(workflowID, startStep));
}
