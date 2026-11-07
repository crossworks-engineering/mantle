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
  RETIRED_CLIENT_TURN_WORKFLOW,
  RETIRED_FORUM_TURN_WORKFLOW,
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

/** The turn workflows of both engines (the owner's, the team's), and the
 *  retired turn names a run recorded before may still carry. Their input
 *  and output hold what the login asked and was answered. */
const TURN_WORKFLOWS: ReadonlySet<string> = new Set([
  ASSISTANT_TURN_WORKFLOW,
  TEAM_TURN_WORKFLOW,
  RETIRED_CLIENT_TURN_WORKFLOW,
  RETIRED_FORUM_TURN_WORKFLOW,
]);

/** Whether a run is a chat turn (runShown, rerunRefused). */
export function isTurnWorkflow(workflowName: string): boolean {
  return TURN_WORKFLOWS.has(workflowName);
}

/** The fields of a turn's inbound or outbound row another viewer sees:
 *  ids, status and times, never its text, thoughts, tools or media. */
const ROW_META = ['id', 'status', 'model', 'traceId', 'createdAt', 'updatedAt'] as const;

/** The options of a turn's input another viewer sees: who ran it and where. */
const OPTION_META = ['loginId', 'streamId', 'windowId'] as const;

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (v[k] !== undefined) out[k] = v[k];
  return out;
}

/** A turn's input as another viewer sees it: the owner and the options'
 *  ids only. */
function inputMeta(input: unknown): unknown {
  const args = Array.isArray(input) ? input : [input];
  const out = args.map((a) => {
    const kept = pick(a, ['ownerId']);
    if (kept === undefined) return null;
    const options = pick((a as { options?: unknown }).options, OPTION_META);
    return { ...kept, ...(options !== undefined ? { options } : {}) };
  });
  return Array.isArray(input) ? out : out[0];
}

/** A turn's output as another viewer sees it: the rows' ids, status and
 *  times, and the result's own numbers and yes-or-no marks (`usedUi`,
 *  `replyChars`); never the reply, a row's text or an artifact. */
function outputMeta(output: unknown): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(output as Record<string, unknown>)) {
    if (k === 'inbound' || k === 'outbound') {
      const row = pick(v, ROW_META);
      if (row !== undefined) out[k] = row;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}

/** The login a turn's run serves (its input's options.loginId), or null. */
function runLogin(input: unknown): string | null {
  const first = Array.isArray(input) ? input[0] : input;
  const login = (first as { options?: { loginId?: unknown } } | null)?.options?.loginId;
  return typeof login === 'string' ? login.toLowerCase() : null;
}

/** Whether `viewerLoginId` is the login a turn's run served. A run that
 *  names no login is nobody's. */
function ownRun(input: unknown, viewerLoginId: string | null): boolean {
  return viewerLoginId !== null && runLogin(input) === viewerLoginId.toLowerCase();
}

/**
 * A run's input and output as the Runners screen shows them to `viewer`
 * (docs/agent-ui.md). A chat turn of either engine holds what its login
 * asked and was answered (a private page it read, a screenshot it
 * attached and its transcript), so its input and output show whole only
 * to that login; any other viewer, another Admin user with Settings
 * included, reads metadata only: the owner and the options' ids, the rows'
 * ids, status and times, the result's numbers and marks. The run's status,
 * timings, steps (names only, never their arguments or results) and error
 * messages show to every viewer as diagnostics. Every other run is shown
 * as it is.
 */
export function runShown(
  workflowName: string,
  input: unknown,
  output: unknown,
  viewerLoginId: string | null,
): { input: unknown; output: unknown } {
  if (!isTurnWorkflow(workflowName)) return { input, output };
  if (ownRun(input, viewerLoginId)) return { input, output };
  return { input: inputMeta(input), output: outputMeta(output) };
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

/**
 * Whether an action on a run (cancel, resume, restart, fork) is refused to
 * `viewerLoginId`: a chat turn re-runs as the login it served (its input),
 * a resumed one drives that login's window again, so only that login acts
 * on it; another viewer, another Admin user included, is told the run is
 * not there (the route's 404). A run that names no login is nobody's to act
 * on. Any other run, or one not found (the engine's own refusal follows),
 * is not refused here.
 */
export async function rerunRefused(
  workflowID: string,
  viewerLoginId: string | null,
): Promise<boolean> {
  const client = await getDbosClient();
  const [s] = await client.listWorkflows({
    workflowIDs: [workflowID],
    loadInput: true,
    limit: 1,
  });
  if (!s || !isTurnWorkflow(s.workflowName)) return false;
  return !ownRun(s.input, viewerLoginId);
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
