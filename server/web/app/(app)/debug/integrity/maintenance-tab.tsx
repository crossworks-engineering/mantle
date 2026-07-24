'use client';

/**
 * Maintenance tab — the frontend for the maintenance task registry
 * (lib/maintenance/registry.ts), so an admin can run hygiene/remedy/ops
 * tasks without a terminal. Tasks preview (dry-run) or apply via
 * /api/debug/maintenance/run; output polls into the console below while the
 * single-flight run is in progress. Same safety rails as `pnpm maintain`,
 * enforced server-side (spend + retired confirms, env checks).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@mantle/web-ui/ui/alert-dialog';
import { Button } from '@mantle/web-ui/ui/button';
import { useToast } from '@mantle/web-ui/ui/toast';
import { apiFetch, apiSend, ApiError } from '@mantle/web-ui/api-fetch';
import type {
  MaintenanceOverview,
  MaintenanceRunView,
  MaintenanceTaskInfo,
  RunHistoryEntry,
  StartRunRequest,
} from '@/lib/maintenance/types';

const KIND_ORDER = ['recurring', 'remedy', 'ops', 'backfill'] as const;
const KIND_LABELS: Record<(typeof KIND_ORDER)[number], string> = {
  recurring: 'Recurring hygiene',
  remedy: 'Remedies — run when a monitor flags drift',
  ops: 'Ops — deliberate events',
  backfill: 'Retired backfills — historical, normally not re-run',
};

function CostBadge({ cost }: { cost: MaintenanceTaskInfo['cost'] }) {
  const spend = cost === 'llm' || cost === 'embedding';
  return (
    <span
      className={
        'rounded-sm border px-1.5 py-0.5 font-mono text-[11px] ' +
        (spend
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border bg-muted text-muted-foreground')
      }
      title={spend ? 'A live run spends real model calls' : 'Free — no model calls'}
    >
      {cost}
    </span>
  );
}

function StatePill({ run }: { run: MaintenanceRunView }) {
  const cls =
    run.state === 'running'
      ? 'bg-primary/10 text-primary border-primary/30'
      : run.state === 'done'
        ? 'bg-primary/10 text-primary border-primary/30'
        : 'bg-destructive/10 text-destructive border-destructive/30';
  return (
    <span className={`rounded-sm border px-1.5 py-0.5 font-mono text-[11px] ${cls}`}>
      {run.state === 'running' ? 'running…' : `${run.state} (exit ${run.exitCode ?? '—'})`}
    </span>
  );
}

function RunButtons({
  task,
  busy,
  onStart,
}: {
  task: MaintenanceTaskInfo;
  busy: boolean;
  onStart: (req: Omit<StartRunRequest, 'slug'>) => void;
}) {
  if (!task.uiRunnable) {
    return <span className="text-xs text-muted-foreground">CLI only</span>;
  }
  if (task.missingEnv.length > 0) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title={`Server is missing: ${task.missingEnv.join(', ')}`}
      >
        needs env: {task.missingEnv.join(', ')}
      </span>
    );
  }

  const spend = task.cost === 'llm' || task.cost === 'embedding';
  const retired = task.status === 'retired';
  const liveNeedsConfirm = spend || retired || !task.supportsDryRun;
  const liveLabel = task.supportsDryRun ? 'Apply' : 'Run';

  return (
    <div className="flex shrink-0 items-center gap-2">
      {task.supportsDryRun ? (
        retired ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={busy}>
                Preview
              </Button>
            </AlertDialogTrigger>
            <RetiredConfirm
              task={task}
              live={false}
              onConfirm={() => onStart({ apply: false, forceRetired: true })}
            />
          </AlertDialog>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onStart({ apply: false })}
          >
            Preview
          </Button>
        )
      ) : null}
      {liveNeedsConfirm ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="sm"
              variant={spend || retired ? 'destructive' : 'default'}
              disabled={busy}
            >
              {liveLabel}
            </Button>
          </AlertDialogTrigger>
          {retired ? (
            <RetiredConfirm
              task={task}
              live
              onConfirm={() =>
                onStart({ apply: true, forceRetired: true, confirmSpend: spend || undefined })
              }
            />
          ) : (
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Run “{task.title}” live?</AlertDialogTitle>
                <AlertDialogDescription>
                  {spend
                    ? `This spends real ${task.cost} calls against the whole corpus. Preview first if unsure.`
                    : `“${task.slug}” has no dry-run mode — invoking it performs the real operation.`}
                  {task.notes ? ` ${task.notes}` : ''}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onStart({ apply: true, confirmSpend: spend || undefined })}
                >
                  {liveLabel} {task.slug}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          )}
        </AlertDialog>
      ) : (
        <Button size="sm" disabled={busy} onClick={() => onStart({ apply: true })}>
          {liveLabel}
        </Button>
      )}
    </div>
  );
}

function RetiredConfirm({
  task,
  live,
  onConfirm,
}: {
  task: MaintenanceTaskInfo;
  live: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {live ? 'Apply' : 'Preview'} a retired backfill — “{task.title}”?
        </AlertDialogTitle>
        <AlertDialogDescription>
          This is a historical migration kept for reference, not casual re-runs. Make sure it still
          applies to this environment.{task.notes ? ` ${task.notes}` : ''}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={onConfirm}>
          {live ? 'Apply' : 'Preview'} {task.slug}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}

export function MaintenanceView() {
  const toast = useToast();
  const [tasks, setTasks] = useState<MaintenanceTaskInfo[]>([]);
  const [history, setHistory] = useState<RunHistoryEntry[]>([]);
  const [run, setRun] = useState<MaintenanceRunView | null>(null);
  const [loading, setLoading] = useState(true);
  const [showRetired, setShowRetired] = useState(false);
  const consoleRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<MaintenanceOverview>('/api/debug/maintenance');
      setTasks(data.tasks);
      setHistory(data.history);
      setRun(data.run);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load maintenance tasks');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll the run while one is in flight.
  const running = run?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const data = await apiFetch<{ run: MaintenanceRunView | null }>(
          '/api/debug/maintenance/run',
        );
        setRun(data.run);
        // Run just finished — refresh the history list (and env/task state).
        if (data.run && data.run.state !== 'running') void load();
      } catch {
        // transient poll failure — next tick retries
      }
    }, 1200);
    return () => clearInterval(t);
  }, [running, load]);

  // Keep the console scrolled to the latest output.
  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.lines.length]);

  const start = useCallback(
    async (slug: string, req: Omit<StartRunRequest, 'slug'>) => {
      try {
        const res = await apiSend<{ run: MaintenanceRunView }>(
          '/api/debug/maintenance/run',
          'POST',
          {
            slug,
            ...req,
          },
        );
        setRun(res.run);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Could not start run');
      }
    },
    [toast],
  );

  const cancel = useCallback(async () => {
    try {
      await apiSend('/api/debug/maintenance/run/cancel', 'POST');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not cancel');
    }
  }, [toast]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading maintenance tasks…</p>;
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Runs the same tasks as <code className="font-mono">pnpm maintain</code> — one at a time,
        with output below. Preview is a dry-run; Apply performs the real operation.
      </p>

      {KIND_ORDER.map((kind) => {
        const group = tasks.filter((t) => t.kind === kind && (kind !== 'backfill' || showRetired));
        if (kind === 'backfill' && !showRetired) {
          return (
            <div key={kind}>
              <button
                type="button"
                onClick={() => setShowRetired(true)}
                className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Show {tasks.filter((t) => t.kind === 'backfill').length} retired backfills…
              </button>
            </div>
          );
        }
        if (group.length === 0) return null;
        return (
          <section key={kind} className="space-y-2">
            <h2 className="text-sm font-semibold text-foreground">{KIND_LABELS[kind]}</h2>
            <ul className="divide-y divide-border rounded-md border border-border bg-card">
              {group.map((t) => (
                <li key={t.slug} className="flex items-start justify-between gap-4 p-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{t.title}</span>
                      <span className="font-mono text-xs text-muted-foreground">{t.slug}</span>
                      <CostBadge cost={t.cost} />
                    </div>
                    <p className="text-xs text-muted-foreground">{t.description}</p>
                  </div>
                  <RunButtons
                    task={t}
                    busy={Boolean(running)}
                    onStart={(req) => start(t.slug, req)}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {run ? (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">
              Run — <span className="font-mono">{run.slug}</span>
            </h2>
            <StatePill run={run} />
            <span className="text-xs text-muted-foreground">
              {run.live ? 'live' : 'dry-run'} · started{' '}
              {new Date(run.startedAt).toLocaleTimeString()}
            </span>
            {running ? (
              <Button size="sm" variant="outline" className="ml-auto" onClick={cancel}>
                Cancel
              </Button>
            ) : null}
          </div>
          <pre
            ref={consoleRef}
            className="max-h-96 overflow-y-auto rounded-md border border-border bg-card p-3 font-mono text-xs text-foreground"
          >
            {run.truncated ? '… (older output dropped)\n' : ''}
            {run.lines.join('\n')}
          </pre>
        </section>
      ) : null}

      {history.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">History</h2>
          <div className="overflow-x-auto rounded-md border border-border bg-card">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="p-2 font-medium">Task</th>
                  <th className="p-2 font-medium">Source</th>
                  <th className="p-2 font-medium">Mode</th>
                  <th className="p-2 font-medium">State</th>
                  <th className="p-2 font-medium">Started</th>
                  <th className="p-2 font-medium">Duration</th>
                  <th className="p-2 font-medium">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {history.map((h) => (
                  <tr key={h.id} className="text-foreground">
                    <td className="p-2 font-mono">{h.slug}</td>
                    <td className="p-2">{h.source}</td>
                    <td className="p-2">{h.live ? 'live' : 'dry-run'}</td>
                    <td
                      className={
                        'p-2 ' +
                        (h.state === 'done'
                          ? 'text-primary'
                          : h.state === 'running'
                            ? 'text-muted-foreground'
                            : 'text-destructive')
                      }
                    >
                      {h.state}
                    </td>
                    <td className="p-2 whitespace-nowrap text-muted-foreground">
                      {new Date(h.startedAt).toLocaleString()}
                    </td>
                    <td className="p-2 whitespace-nowrap text-muted-foreground">
                      {formatDuration(h.startedAt, h.finishedAt)}
                    </td>
                    <td
                      className="max-w-96 truncate p-2 text-muted-foreground"
                      title={h.summary ?? ''}
                    >
                      {h.summary ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return '—';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
