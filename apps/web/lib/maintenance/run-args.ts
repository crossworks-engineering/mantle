/**
 * Pure request→argv validation for maintenance runs — the same safety rails
 * the CLI enforces (scripts/maintain.ts), shared by the /api/debug/maintenance
 * routes so the frontend can never bypass them. Env is passed in (not read)
 * to keep this testable.
 */
import { isLiveRun, type MaintenanceTask } from './registry';
import type { StartRunRequest } from './types';

export type RunPlan =
  | { ok: true; args: string[]; live: boolean }
  | { ok: false; error: string; status: 400 | 403 };

export function planRun(
  task: MaintenanceTask,
  req: Omit<StartRunRequest, 'slug'>,
  env: Record<string, string | undefined>,
): RunPlan {
  if (task.positionalArgs?.length) {
    return {
      ok: false,
      status: 400,
      error: `"${task.slug}" needs positional args (${task.positionalArgs.join(' ')}) — run it from the terminal.`,
    };
  }

  if (task.status === 'retired' && !req.forceRetired) {
    return {
      ok: false,
      status: 403,
      error: `"${task.slug}" is a retired backfill — confirm the retired-task warning to run it anyway.`,
    };
  }

  const missingEnv = (task.requiresEnv ?? []).filter((k) => !env[k]);
  if (missingEnv.length) {
    return {
      ok: false,
      status: 400,
      error: `"${task.slug}" needs env var(s) not set on the server: ${missingEnv.join(', ')}.`,
    };
  }

  let args: string[];
  if (task.applyFlag) {
    // Dry-run by default; the apply flag opts into a live run.
    args = req.apply ? [task.applyFlag] : [];
  } else if (task.dryRunFlag) {
    // Live by default; the dry-run flag opts into a preview.
    args = req.apply ? [] : [task.dryRunFlag];
  } else {
    // No dry-run convention — the only possible run is live.
    if (!req.apply) {
      return {
        ok: false,
        status: 400,
        error: `"${task.slug}" has no dry-run mode — it can only be run live.`,
      };
    }
    args = [];
  }

  const live = isLiveRun(task, args);
  if (live && (task.cost === 'llm' || task.cost === 'embedding') && !req.confirmSpend) {
    return {
      ok: false,
      status: 403,
      error: `A live run of "${task.slug}" spends real ${task.cost} calls — confirm the spend warning first.`,
    };
  }

  return { ok: true, args, live };
}
