/**
 * Server-side maintenance run store: spawns a registry task's script as a
 * child process (same invocation as `pnpm maintain`), line-buffers its
 * output, and exposes the current/last run for the polling UI.
 *
 * Single-flight by design — one run at a time, app-wide. This is a
 * single-owner app and every task is a whole-corpus sweep; concurrent runs
 * would only fight each other. State lives on `globalThis` so dev HMR
 * doesn't orphan a running child behind a fresh module instance.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { MaintenanceTask } from './registry';
import type { MaintenanceRunView, RunState } from '@mantle/web-ui/types/maintenance';
import { finishRun, recordRunStart } from './history';

const MAX_LINES = 2000;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** After a stop request, how long a SIGTERM-trapping child gets before SIGKILL. */
const KILL_GRACE_MS = 10 * 1000;

interface RunRecord {
  id: string;
  slug: string;
  live: boolean;
  state: RunState;
  startedAt: Date;
  finishedAt?: Date;
  exitCode?: number | null;
  lines: string[];
  truncated: boolean;
  child?: ChildProcess;
  timeout?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  /** Set by a stop request (cancel/timeout); applied as the terminal state
   *  when the child's 'close' finally fires. While set, the run still counts
   *  as running so the single-flight lock stays held. */
  pendingState?: 'cancelled' | 'failed';
  /** maintenance_runs row id (best-effort history; null when the insert failed). */
  historyId?: string | null;
}

const store = globalThis as unknown as { __mantleMaintenanceRun?: RunRecord };

/** Walk up from cwd to the workspace root (next dev/start runs in apps/web). */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('maintenance: could not locate the workspace root from ' + process.cwd());
}

function pushLine(run: RunRecord, line: string): void {
  run.lines.push(line);
  if (run.lines.length > MAX_LINES) {
    run.lines.splice(0, run.lines.length - MAX_LINES);
    run.truncated = true;
  }
}

/** Settle the maintenance_runs row for a finished run (best-effort, idempotent
 *  — safe to call again when e.g. the exit code lands after a cancel). */
async function writeHistoryFinish(run: RunRecord): Promise<void> {
  if (!run.historyId || run.state === 'running') return;
  const summary = [...run.lines].reverse().find((l) => l.trim().length > 0);
  try {
    await finishRun(run.historyId, {
      state: run.state,
      exitCode: run.exitCode ?? null,
      summary,
    });
  } catch (err) {
    console.error('[maintenance] history update failed:', err);
  }
}

/** Split a stdio chunk into lines, carrying partial-line remainders. */
function lineSink(run: RunRecord): (chunk: Buffer) => void {
  let rest = '';
  return (chunk) => {
    rest += chunk.toString('utf8');
    const parts = rest.split(/\r?\n/);
    rest = parts.pop() ?? '';
    for (const p of parts) pushLine(run, p);
  };
}

export function getRun(): MaintenanceRunView | null {
  const run = store.__mantleMaintenanceRun;
  if (!run) return null;
  return {
    id: run.id,
    slug: run.slug,
    live: run.live,
    state: run.state,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString(),
    exitCode: run.exitCode,
    lines: run.lines,
    truncated: run.truncated,
  };
}

export function isRunning(): boolean {
  return store.__mantleMaintenanceRun?.state === 'running';
}

export function startRun(
  task: MaintenanceTask,
  args: string[],
  live: boolean,
): { ok: true; id: string } | { ok: false; error: string } {
  if (isRunning()) {
    return { ok: false, error: 'a maintenance run is already in progress' };
  }

  const run: RunRecord = {
    id: randomUUID(),
    slug: task.slug,
    live,
    state: 'running',
    startedAt: new Date(),
    lines: [],
    truncated: false,
  };

  const cwd = resolve(repoRoot(), task.cwd);
  pushLine(
    run,
    `$ tsx ${task.script}${args.length ? ' ' + args.join(' ') : ''}  (${live ? 'LIVE' : 'dry-run'})`,
  );

  let child: ChildProcess;
  try {
    child = spawn('pnpm', ['exec', 'tsx', task.script, ...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return { ok: false, error: `failed to spawn: ${err instanceof Error ? err.message : err}` };
  }

  run.child = child;
  store.__mantleMaintenanceRun = run;

  // Best-effort unified history (maintenance_runs) — a DB hiccup must never
  // block the run itself.
  recordRunStart({ slug: task.slug, source: 'ui', live })
    .then((id) => {
      run.historyId = id;
      // The child can finish before the insert returns — settle the row now.
      if (run.state !== 'running') void writeHistoryFinish(run);
    })
    .catch((err) => {
      run.historyId = null;
      console.error('[maintenance] history insert failed:', err);
    });

  // The ONLY place a run reaches a terminal state — always via the child's
  // 'close'/'error' event, never before it. That keeps the single-flight
  // lock (isRunning ⇐ state==='running') held until the old child is
  // actually gone, so a stop request can't let a second run overlap a
  // SIGTERM-trapping script.
  const finish = (state: RunState, exitCode: number | null) => {
    if (run.state !== 'running') return;
    run.state = state;
    run.exitCode = exitCode;
    run.finishedAt = new Date();
    run.child = undefined;
    if (run.timeout) clearTimeout(run.timeout);
    if (run.killTimer) clearTimeout(run.killTimer);
    void writeHistoryFinish(run);
  };

  child.stdout?.on('data', lineSink(run));
  child.stderr?.on('data', lineSink(run));

  child.on('error', (err) => {
    pushLine(run, `spawn error: ${err.message}`);
    finish('failed', null);
  });
  child.on('close', (code) => {
    // A requested stop (cancel/timeout) fixes the terminal state; otherwise
    // map the exit code.
    finish(run.pendingState ?? (code === 0 ? 'done' : 'failed'), code);
  });

  run.timeout = setTimeout(() => {
    requestStop(run, 'failed', `maintenance: run exceeded ${RUN_TIMEOUT_MS / 60000} min — killing`);
  }, RUN_TIMEOUT_MS);
  run.timeout.unref?.();

  return { ok: true, id: run.id };
}

/** Ask the child to stop: SIGTERM now, SIGKILL if it's still alive after a
 *  grace period (a script may trap SIGTERM for cleanup — or wedge). The run
 *  stays 'running' until 'close' fires; `state` records what to finish as. */
function requestStop(run: RunRecord, state: 'cancelled' | 'failed', note: string): void {
  if (run.state !== 'running' || !run.child || run.pendingState) return;
  pushLine(run, note);
  run.pendingState = state;
  const child = run.child;
  child.kill('SIGTERM');
  run.killTimer = setTimeout(() => {
    if (run.state === 'running') {
      pushLine(run, 'maintenance: still alive after SIGTERM — sending SIGKILL');
      child.kill('SIGKILL');
    }
  }, KILL_GRACE_MS);
  run.killTimer.unref?.();
}

export function cancelRun(): { ok: boolean; error?: string } {
  const run = store.__mantleMaintenanceRun;
  if (!run || run.state !== 'running' || !run.child) {
    return { ok: false, error: 'no run in progress' };
  }
  if (run.pendingState) {
    return { ok: false, error: 'already stopping' };
  }
  requestStop(run, 'cancelled', 'maintenance: cancelled from the UI — stopping…');
  return { ok: true };
}
