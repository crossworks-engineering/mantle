/**
 * Client-safe wire types for the /api/debug/maintenance surface. Mirrors the
 * registry (lib/maintenance/registry.ts) plus server-computed runnability —
 * kept separate so the browser bundle never pulls server modules.
 */
export type TaskCost = 'sql' | 'io' | 'imap' | 'crypto' | 'embedding' | 'llm';
export type TaskKind =
  /** Drifts back as new data arrives — the only kind eligible for scheduling. */
  | 'recurring'
  /** One-shot fix re-run only when a monitor (dashboard card) flags drift. */
  | 'remedy'
  /** Deliberate operational event: model change, key rotation, deploy bootstrap. */
  | 'ops'
  /** Historical migration/backfill. */
  | 'backfill';
export type TaskStatus = 'live' | 'retired';

/** A value the UI runner asks for and passes to the script as
 *  `--<name>=<value>`: the agent a dry run works on, the review page an apply
 *  reads. `for` says which run needs it. */
export interface MaintenanceArg {
  name: string;
  /** What the value is, so the UI can offer the right picker. */
  kind: 'agent' | 'page';
  label: string;
  for: 'dry' | 'apply';
}

export interface MaintenanceTaskInfo {
  slug: string;
  title: string;
  description: string;
  kind: TaskKind;
  status: TaskStatus;
  cost: TaskCost;
  schedulable: boolean;
  /** Which run modes exist: a task with a dry-run convention supports preview. */
  supportsDryRun: boolean;
  /** False when the task needs positional args (backups' destDir) — CLI only. */
  uiRunnable: boolean;
  /** Values the UI must collect before a run (see MaintenanceArg). */
  args?: MaintenanceArg[];
  /** What a DRY run spends when it is not free: the UI asks to confirm it. */
  dryRunCost?: TaskCost;
  /** Env vars from requiresEnv that are NOT set on the server, if any. */
  missingEnv: string[];
  notes?: string;
}

export type RunState = 'running' | 'done' | 'failed' | 'cancelled';

export interface MaintenanceRunView {
  id: string;
  slug: string;
  /** True when this run mutates / spends (not a dry-run). */
  live: boolean;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  /** Captured stdout+stderr, line-buffered, capped (oldest dropped). */
  lines: string[];
  truncated: boolean;
}

/** One maintenance_runs row on the wire — unified history across surfaces. */
export interface RunHistoryEntry {
  id: string;
  slug: string;
  source: 'cli' | 'ui' | 'cron';
  live: boolean;
  state: RunState;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  summary: string | null;
}

export interface MaintenanceOverview {
  tasks: MaintenanceTaskInfo[];
  run: MaintenanceRunView | null;
  history: RunHistoryEntry[];
}

export interface StartRunRequest {
  slug: string;
  /** Live run (maps to the script's own apply flag / omits its dry-run flag). */
  apply: boolean;
  /** Required acknowledgement for any run that spends llm/embedding calls
   *  (live runs of such tasks, and dry runs with a costly dryRunCost). */
  confirmSpend?: boolean;
  /** Values for the task's `args`, keyed by MaintenanceArg.name. */
  args?: Record<string, string>;
  /** Required acknowledgement for retired backfills. */
  forceRetired?: boolean;
}
