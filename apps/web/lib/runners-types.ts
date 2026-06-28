/**
 * Pure types + presentation helpers for the Runners screen — Mantle's in-app
 * replica of the DBOS admin console. No DBOS / pg imports, so it's safe to pull
 * into a client component without dragging the DBOS SDK + postgres into the
 * browser bundle. The server-only data layer lives in `./runners.ts`.
 *
 * Everything here mirrors DBOS's WorkflowStatus / StepInfo (the system-DB
 * execution journal); see apps/api/src/runs.ts for the original apps/api-side
 * read layer this parallels.
 */

/** DBOS workflow lifecycle states (StatusString in the SDK). */
export type RunnerStatus =
  | 'ENQUEUED'
  | 'PENDING'
  | 'SUCCESS'
  | 'ERROR'
  | 'CANCELLED'
  | 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'
  | 'DELAYED';

/** Order shown as filter chips (active states first, terminal after). */
export const RUNNER_STATUSES: RunnerStatus[] = [
  'ENQUEUED',
  'PENDING',
  'SUCCESS',
  'ERROR',
  'CANCELLED',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
  'DELAYED',
];

/** A run is still in flight (queued, delayed, or executing). */
export function isRunnerActive(status: string): boolean {
  return status === 'ENQUEUED' || status === 'PENDING' || status === 'DELAYED';
}

/** A single runner execution, projected from DBOS WorkflowStatus. */
export type RunnerRun = {
  workflowID: string;
  /** Runner function name, e.g. 'assistantTurnWorkflow' / 'pingWorkflow'. */
  name: string;
  status: string;
  queue?: string;
  /** Which apps/api process executed it (helps when scaled out). */
  executorId?: string;
  appVersion?: string;
  /** How many times DBOS has tried to recover this run after a crash. */
  recoveryAttempts?: number;
  createdAt: number;
  dequeuedAt?: number;
  completedAt?: number;
  updatedAt?: number;
  /** Wall-clock the runner actually executed (ms). Undefined until completed. */
  runMs?: number;
  /** End-to-end latency incl. queue wait (ms). Undefined until completed. */
  totalMs?: number;
  /** Time spent waiting in the queue before a worker picked it up (ms). */
  queuedMs?: number;
  /** Failure message when status is a failure state. */
  error?: string;
};

/** One journaled step within a run (DBOS StepInfo). */
export type RunnerStep = {
  functionID: number;
  name: string;
  durationMs?: number;
  startedAt?: number;
  completedAt?: number;
  /** Set when this step invoked a child workflow. */
  childWorkflowID?: string;
  error?: string;
};

/** A run plus its steps and (truncated) input/output, for the detail pane. */
export type RunnerRunDetail = RunnerRun & {
  /** Truncated JSON preview of the run's input args (owner-only). */
  input?: string;
  /** Truncated JSON preview of the run's return value (owner-only). */
  output?: string;
  steps: RunnerStep[];
};

/** Queue config + live counts — the header "is the runner healthy" strip. */
export type RunnerQueueHealth = {
  name: string;
  /** Global cap on concurrently-executing runs across all workers. */
  concurrency?: number;
  /** Per-worker cap. */
  workerConcurrency?: number;
  rateLimit?: { limitPerPeriod: number; periodSec: number };
  /** Runs waiting in the queue (ENQUEUED). */
  enqueued: number;
  /** Runs currently executing (PENDING). */
  pending: number;
};

export type RunnerListPage = {
  runs: RunnerRun[];
  /** True when another page exists (we over-fetch by one to know). */
  hasMore: boolean;
};

/** The lifecycle controls this screen exposes (the "observe + lifecycle" cut —
 *  no destructive maintenance like delete / garbage-collect). */
export type RunnerAction = 'cancel' | 'resume' | 'restart' | 'fork';

/**
 * Which lifecycle actions make sense for a run in a given status. Drives which
 * buttons render in the detail pane.
 *  - cancel:  only an in-flight run can be cancelled.
 *  - resume:  re-run a halted run from its last completed step.
 *  - restart: fork from step 0 → a brand-new run from scratch (new id).
 *  - fork:    fork from a chosen step → a new run (new id).
 */
export function availableActions(status: string): RunnerAction[] {
  switch (status) {
    case 'ENQUEUED':
    case 'PENDING':
    case 'DELAYED':
      return ['cancel'];
    case 'CANCELLED':
    case 'MAX_RECOVERY_ATTEMPTS_EXCEEDED':
      return ['resume', 'restart', 'fork'];
    case 'ERROR':
      return ['resume', 'restart', 'fork'];
    case 'SUCCESS':
      return ['restart', 'fork'];
    default:
      return [];
  }
}

export const RUNNER_ACTION_LABEL: Record<RunnerAction, string> = {
  cancel: 'Cancel',
  resume: 'Resume',
  restart: 'Restart',
  fork: 'Fork from step',
};

/** Status dot colour — mirrors the /traces palette (emerald/amber/destructive/
 *  muted) plus sky for "queued/waiting" so a waiting run reads apart from a
 *  running one. */
export function runnerStatusDot(status: string): string {
  switch (status) {
    case 'SUCCESS':
      return 'bg-emerald-500';
    case 'ERROR':
    case 'MAX_RECOVERY_ATTEMPTS_EXCEEDED':
      return 'bg-destructive';
    case 'CANCELLED':
      return 'bg-muted-foreground/40';
    case 'PENDING':
      return 'bg-amber-500';
    case 'ENQUEUED':
    case 'DELAYED':
      return 'bg-sky-500';
    default:
      return 'bg-muted-foreground/40';
  }
}

export function runnerStatusText(status: string): string {
  switch (status) {
    case 'SUCCESS':
      return 'text-emerald-700 dark:text-emerald-300';
    case 'ERROR':
    case 'MAX_RECOVERY_ATTEMPTS_EXCEEDED':
      return 'text-destructive';
    case 'CANCELLED':
      return 'text-muted-foreground';
    case 'PENDING':
      return 'text-amber-700 dark:text-amber-300';
    case 'ENQUEUED':
    case 'DELAYED':
      return 'text-sky-700 dark:text-sky-300';
    default:
      return 'text-muted-foreground';
  }
}

/** Compact label for a status (the long MAX_RECOVERY… is unwieldy in a chip). */
export function runnerStatusLabel(status: string): string {
  return status === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED' ? 'MAX RETRIES' : status;
}
