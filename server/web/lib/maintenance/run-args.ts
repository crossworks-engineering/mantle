/**
 * Pure request→argv validation for maintenance runs — the same safety rails
 * the CLI enforces (scripts/maintain.ts), shared by the /api/debug/maintenance
 * routes so the frontend can never bypass them. Env is passed in (not read)
 * to keep this testable.
 */
import { isLiveRun, SESSION_ENV, type MaintenanceTask } from './registry';
import type { StartRunRequest } from '@mantle/client-types/types/maintenance';
import { isUuid } from '@mantle/std';

export type RunPlan =
  { ok: true; args: string[]; live: boolean } | { ok: false; error: string; status: 400 | 403 };

export function planRun(
  task: MaintenanceTask,
  req: Omit<StartRunRequest, 'slug'>,
  env: Record<string, string | undefined>,
): RunPlan {
  if (task.cliOnly) {
    return {
      ok: false,
      status: 400,
      error: `"${task.slug}" runs from the terminal only: it ${task.cliOnly}.`,
    };
  }

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
  const argError = uiArgError(task, req);
  if (argError) return { ok: false, status: 400, error: argError };
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
  if (live && isPaid(task.cost) && !req.confirmSpend) {
    return {
      ok: false,
      status: 403,
      error: `A live run of "${task.slug}" spends real ${task.cost} calls — confirm the spend warning first.`,
    };
  }
  // Same rail as the CLI's: a preview that calls a model asks too.
  if (!live && task.dryRunCost && isPaid(task.dryRunCost) && !req.confirmSpend) {
    return {
      ok: false,
      status: 403,
      error: `A dry run of "${task.slug}" spends real ${task.dryRunCost} calls — confirm the spend warning first.`,
    };
  }

  return { ok: true, args: [...args, ...uiArgFlags(task, req)], live };
}

function isPaid(cost: MaintenanceTask['cost']): boolean {
  return cost === 'llm' || cost === 'embedding';
}

const AGENT_SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/;

/** The task's args this run needs (dry or apply), each with its value. */
function neededArgs(task: MaintenanceTask, req: Omit<StartRunRequest, 'slug'>) {
  const mode = req.apply ? 'apply' : 'dry';
  return (task.uiArgs ?? [])
    .filter((a) => a.for === mode)
    .map((a) => ({ arg: a, value: (req.args?.[a.name] ?? '').trim() }));
}

/** A missing or malformed value, as the error to show; null when all fit.
 *  Values become argv, so each kind has a strict shape. */
function uiArgError(task: MaintenanceTask, req: Omit<StartRunRequest, 'slug'>): string | null {
  for (const { arg, value } of neededArgs(task, req)) {
    if (!value) return `"${task.slug}" needs ${arg.label.toLowerCase()} for this run.`;
    const ok = arg.kind === 'agent' ? AGENT_SLUG.test(value) : isUuid(value);
    if (!ok)
      return `${arg.label} "${value}" is not a valid ${arg.kind === 'agent' ? 'agent slug' : 'page id'}.`;
  }
  return null;
}

function uiArgFlags(task: MaintenanceTask, req: Omit<StartRunRequest, 'slug'>): string[] {
  return neededArgs(task, req).map(({ arg, value }) => `--${arg.name}=${value}`);
}

/** The env a UI run gets: the server's, with each SESSION_ENV key the box
 *  leaves empty filled from the signed-in owner (a script that scopes to
 *  ALLOWED_USER_ID then works on this owner's brain). A set value wins. */
export function runEnv(
  env: Record<string, string | undefined>,
  ownerId: string,
): Record<string, string | undefined> {
  const out = { ...env };
  for (const k of SESSION_ENV) if (!out[k]) out[k] = ownerId;
  return out;
}
