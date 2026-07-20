/**
 * Client-safe wire types for the /api/debug/maintenance surface. Mirrors the
 * registry (lib/maintenance/registry.ts) plus server-computed runnability —
 * kept separate so the browser bundle never pulls server modules.
 */
import type { TaskCost, TaskKind, TaskStatus } from './registry';

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

export interface MaintenanceOverview {
  tasks: MaintenanceTaskInfo[];
  run: MaintenanceRunView | null;
}

export interface StartRunRequest {
  slug: string;
  /** Live run (maps to the script's own apply flag / omits its dry-run flag). */
  apply: boolean;
  /** Required acknowledgement for live runs of llm/embedding-cost tasks. */
  confirmSpend?: boolean;
  /** Required acknowledgement for retired backfills. */
  forceRetired?: boolean;
}
