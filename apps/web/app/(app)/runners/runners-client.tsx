'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Copy, GitFork, Loader2 } from 'lucide-react';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { formatDateTime } from '@mantle/web-ui/lib/format-datetime';
import { formatDuration } from '@/lib/traces-format';
import {
  availableActions,
  isRunnerActive,
  RUNNER_ACTION_LABEL,
  RUNNER_STATUSES,
  runnerStatusDot,
  runnerStatusLabel,
  runnerStatusText,
  type RunnerAction,
  type RunnerQueueHealth,
  type RunnerRun,
  type RunnerRunDetail,
} from '@/lib/runners-types';
import { Button } from '@mantle/web-ui/ui/button';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { useToast } from '@mantle/web-ui/ui/toast';
import { cn } from '@mantle/web-ui/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@mantle/web-ui/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@mantle/web-ui/ui/dialog';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import { copyText } from '@mantle/web-ui/lib/secure-context-fallbacks';

const HOURS_OPTIONS: Array<[number, string]> = [
  [1, '1h'],
  [6, '6h'],
  [24, '24h'],
  [168, '7d'],
  [0, 'All'],
];

type RunsPage = { runs: RunnerRun[]; hasMore: boolean; page: number };
type Meta = { queue: RunnerQueueHealth; names: string[] };

/**
 * /runners master-detail — Mantle's DBOS admin console. The page parses URL
 * state and hands it here; this fetches the run list (GET /api/runners), the
 * queue health + names (GET /api/runners/meta), and the selected run
 * (GET /api/runners/[id]) via useQuery, and runs lifecycle actions
 * (POST /api/runners/[id]) via useMutation. Filters/select/pager are URL-driven
 * `<Link>`s. List + queue header poll so in-flight runs stay live.
 */
export function RunnersClient({
  statuses,
  name,
  hours,
  page,
  selected,
}: {
  statuses: string[];
  name: string | null;
  hours: number;
  page: number;
  selected: string | null;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [forkOpen, setForkOpen] = useState(false);
  const [confirm, setConfirm] = useState<{
    action: Exclude<RunnerAction, 'fork'>;
    run: RunnerRun;
  } | null>(null);
  const hasFilters = statuses.length > 0 || !!name || hours !== 0;

  const listQuery = useQuery({
    queryKey: ['runners', { statuses, name, hours, page }],
    queryFn: () => {
      const p = new URLSearchParams();
      for (const s of statuses) p.append('status', s);
      if (name) p.set('name', name);
      if (hours > 0) p.set('hours', String(hours));
      if (page > 1) p.set('page', String(page));
      const q = p.toString();
      return apiFetch<RunsPage>(q ? `/api/runners?${q}` : '/api/runners');
    },
    placeholderData: (prev) => prev,
    refetchInterval: 5000,
  });

  const metaQuery = useQuery({
    queryKey: ['runners-meta'],
    queryFn: () => apiFetch<Meta>('/api/runners/meta'),
    refetchInterval: 5000,
  });

  const rows = listQuery.data?.runs ?? [];
  const selectedId = selected ?? rows[0]?.workflowID ?? null;

  const detailQuery = useQuery({
    queryKey: ['runner', selectedId],
    queryFn: () => apiFetch<{ run: RunnerRunDetail }>(`/api/runners/${selectedId}`),
    enabled: !!selectedId,
    refetchInterval: (q) =>
      q.state.data && isRunnerActive(q.state.data.run.status) ? 3000 : false,
  });
  const detail = detailQuery.data?.run ?? null;

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['runners'] });
    void qc.invalidateQueries({ queryKey: ['runners-meta'] });
    void qc.invalidateQueries({ queryKey: ['runner'] });
  };

  const actionMutation = useMutation({
    mutationFn: (vars: { id: string; action: RunnerAction; startStep?: number }) =>
      apiFetch<{ ok: boolean; newWorkflowID?: string }>(`/api/runners/${vars.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: vars.action,
          ...(vars.startStep != null ? { startStep: vars.startStep } : {}),
        }),
      }),
    onSuccess: (data, vars) => {
      const label = RUNNER_ACTION_LABEL[vars.action];
      if (data.newWorkflowID) {
        toast.success(`${label} → new run ${shortId(data.newWorkflowID)}`);
        router.push(href({ selected: data.newWorkflowID }));
      } else {
        toast.success(`${label} requested`);
      }
      refreshAll();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Action failed.'),
  });

  /** Build a /runners URL from current state with overrides applied. */
  function href(over: {
    statuses?: string[];
    name?: string | null;
    hours?: number;
    page?: number;
    selected?: string | null;
  }) {
    const n = { statuses, name, hours, page, selected, ...over };
    const p = new URLSearchParams();
    for (const s of n.statuses) p.append('status', s);
    if (n.name) p.set('name', n.name);
    if (n.hours > 0) p.set('hours', String(n.hours));
    if (n.page > 1) p.set('page', String(n.page));
    if (n.selected) p.set('selected', n.selected);
    const q = p.toString();
    return q ? `/runners?${q}` : '/runners';
  }

  const queue = metaQuery.data?.queue;
  const names = metaQuery.data?.names ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Queue health header */}
      <div className="shrink-0 border-b border-border px-3 py-2.5">
        <QueueHealth queue={queue} loading={metaQuery.isPending} />
      </div>

      {/* Filters */}
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <FilterRow label="Status">
          {RUNNER_STATUSES.map((s) => (
            <FilterChip
              key={s}
              href={href({ statuses: toggle(statuses, s), page: 1 })}
              active={statuses.includes(s)}
            >
              {runnerStatusLabel(s)}
            </FilterChip>
          ))}
        </FilterRow>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {names.length > 0 && (
            <FilterRow label="Runner">
              {names.map((nm) => (
                <FilterChip
                  key={nm}
                  href={href({ name: name === nm ? null : nm, page: 1 })}
                  active={name === nm}
                >
                  {nm}
                </FilterChip>
              ))}
            </FilterRow>
          )}
          <FilterRow label="Window">
            {HOURS_OPTIONS.map(([value, label]) => (
              <FilterChip
                key={value}
                href={href({ hours: value, page: 1 })}
                active={hours === value}
              >
                {label}
              </FilterChip>
            ))}
          </FilterRow>
          {hasFilters && (
            <Link
              href={href({ statuses: [], name: null, hours: 0, page: 1 })}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Reset
            </Link>
          )}
        </div>
      </div>

      {/* Master-detail */}
      <div className="md:grid md:min-h-0 md:flex-1 md:grid-cols-[minmax(340px,400px)_1fr] md:overflow-hidden">
        {/* Left: run cards */}
        <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
          <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
            {listQuery.isPending ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : listQuery.isError ? (
              <Empty>Couldn&apos;t load runs.</Empty>
            ) : rows.length === 0 ? (
              <Empty>No runs match these filters.</Empty>
            ) : (
              rows.map((r) => (
                <Link
                  key={r.workflowID}
                  href={href({ selected: r.workflowID })}
                  className={cn(
                    'block rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 transition-colors hover:bg-muted/50',
                    selectedId === r.workflowID && 'border-l-primary',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        className={cn('size-2 shrink-0 rounded-full', runnerStatusDot(r.status))}
                        aria-hidden
                      />
                      <span className="truncate text-sm font-medium">{r.name}</span>
                      <span
                        className={cn(
                          'shrink-0 text-[10px] uppercase tracking-wider',
                          runnerStatusText(r.status),
                        )}
                      >
                        {runnerStatusLabel(r.status)}
                      </span>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {formatDateTime(new Date(r.createdAt).toISOString())}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
                    <span>run {formatDuration(r.runMs ?? null)}</span>
                    <span>queued {formatDuration(r.queuedMs ?? null)}</span>
                    {r.queue && <span>{r.queue}</span>}
                    {(r.recoveryAttempts ?? 0) > 1 && (
                      <span className="text-amber-700 dark:text-amber-300">
                        ↻ {r.recoveryAttempts}
                      </span>
                    )}
                  </div>
                  {r.error && (
                    <div className="mt-0.5 truncate text-xs text-destructive">{r.error}</div>
                  )}
                </Link>
              ))
            )}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{rows.length} on this page</span>
            <div className="flex items-center gap-1.5">
              <span className="tabular-nums">page {page}</span>
              <PagerLink href={href({ page: page - 1 })} disabled={page <= 1} label="Previous page">
                <ChevronLeft />
              </PagerLink>
              <PagerLink
                href={href({ page: page + 1 })}
                disabled={!listQuery.data?.hasMore}
                label="Next page"
              >
                <ChevronRight />
              </PagerLink>
            </div>
          </div>
        </div>

        {/* Right: detail */}
        <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
          {!selectedId ? (
            <Centered>Select a run to inspect its steps and controls.</Centered>
          ) : detailQuery.isPending ? (
            <div className="flex h-full items-center justify-center py-10">
              <Spinner />
            </div>
          ) : detailQuery.isError || !detail ? (
            <Centered>Couldn&apos;t load this run.</Centered>
          ) : (
            <RunDetail
              run={detail}
              busy={actionMutation.isPending}
              onAction={(action) => {
                if (action === 'fork') setForkOpen(true);
                else setConfirm({ action, run: detail });
              }}
              onCopyId={() => {
                void copyText(detail.workflowID);
                toast.info('Workflow id copied');
              }}
            />
          )}
        </div>
      </div>

      {/* Confirm cancel / resume / restart */}
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm ? RUNNER_ACTION_LABEL[confirm.action] : ''} this run?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm && confirmCopy(confirm.action)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep as is</AlertDialogCancel>
            <AlertDialogAction
              className={
                confirm?.action === 'cancel'
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : ''
              }
              onClick={() => {
                if (confirm)
                  actionMutation.mutate({ id: confirm.run.workflowID, action: confirm.action });
                setConfirm(null);
              }}
            >
              {confirm ? RUNNER_ACTION_LABEL[confirm.action] : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Fork-from-step dialog */}
      {detail && (
        <ForkDialog
          open={forkOpen}
          onOpenChange={setForkOpen}
          run={detail}
          onFork={(startStep) => {
            actionMutation.mutate({ id: detail.workflowID, action: 'fork', startStep });
            setForkOpen(false);
          }}
        />
      )}
    </div>
  );
}

function confirmCopy(action: Exclude<RunnerAction, 'fork'>): string {
  if (action === 'cancel')
    return 'Marks the run CANCELLED and stops it (and any child workflows) at the next checkpoint. Use Resume later to pick it back up.';
  if (action === 'resume')
    return 'Re-enqueues the run and continues from its last completed step. Keeps the same workflow id.';
  return 'Forks from step 0 — a brand-new run from scratch, with a new workflow id. The original is left untouched.';
}

function QueueHealth({ queue, loading }: { queue?: RunnerQueueHealth; loading: boolean }) {
  if (loading || !queue) {
    return <div className="text-xs text-muted-foreground">Loading queue…</div>;
  }
  const busy = queue.pending > 0 || queue.enqueued > 0;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
      <span className="flex items-center gap-1.5 font-medium">
        <span
          className={cn('size-2 rounded-full', busy ? 'bg-amber-500' : 'bg-emerald-500')}
          aria-hidden
        />
        Queue <span className="font-mono text-muted-foreground">{queue.name}</span>
      </span>
      <Stat label="running" value={queue.pending} highlight={queue.pending > 0} />
      <Stat label="queued" value={queue.enqueued} highlight={queue.enqueued > 0} />
      {queue.concurrency != null && <Stat label="concurrency" value={queue.concurrency} />}
      {queue.workerConcurrency != null && (
        <Stat label="per-worker" value={queue.workerConcurrency} />
      )}
      {queue.rateLimit && (
        <span className="text-muted-foreground">
          rate {queue.rateLimit.limitPerPeriod}/{queue.rateLimit.periodSec}s
        </span>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <span className="flex items-baseline gap-1 tabular-nums">
      <span
        className={cn(
          'font-semibold',
          highlight ? 'text-amber-700 dark:text-amber-300' : 'text-foreground',
        )}
      >
        {value}
      </span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function RunDetail({
  run,
  busy,
  onAction,
  onCopyId,
}: {
  run: RunnerRunDetail;
  busy: boolean;
  onAction: (action: RunnerAction) => void;
  onCopyId: () => void;
}) {
  const actions = availableActions(run.status);
  return (
    <div className="space-y-5 p-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className={cn('size-2.5 rounded-full', runnerStatusDot(run.status))} aria-hidden />
          <h2 className="text-lg font-semibold">{run.name}</h2>
          <span className={cn('text-xs uppercase tracking-wider', runnerStatusText(run.status))}>
            {runnerStatusLabel(run.status)}
          </span>
        </div>
        <button
          type="button"
          onClick={onCopyId}
          className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
          title="Copy workflow id"
        >
          {run.workflowID}
          <Copy className="size-3" />
        </button>
      </div>

      {/* Actions */}
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <Button
              key={a}
              size="sm"
              variant={a === 'cancel' ? 'destructive' : a === 'resume' ? 'default' : 'outline'}
              disabled={busy}
              onClick={() => onAction(a)}
            >
              {busy && <Loader2 className="animate-spin" />}
              {a === 'fork' && <GitFork />}
              {RUNNER_ACTION_LABEL[a]}
            </Button>
          ))}
        </div>
      )}

      {run.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {run.error}
        </div>
      )}

      {/* Timing + meta */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <Field label="Enqueued" value={formatDateTime(new Date(run.createdAt).toISOString())} />
        <Field
          label="Started"
          value={run.dequeuedAt ? formatDateTime(new Date(run.dequeuedAt).toISOString()) : '—'}
        />
        <Field
          label="Completed"
          value={run.completedAt ? formatDateTime(new Date(run.completedAt).toISOString()) : '—'}
        />
        <Field label="Run time" value={formatDuration(run.runMs ?? null)} />
        <Field label="Queue wait" value={formatDuration(run.queuedMs ?? null)} />
        <Field label="End-to-end" value={formatDuration(run.totalMs ?? null)} />
        {run.queue && <Field label="Queue" value={run.queue} mono />}
        {run.executorId && <Field label="Executor" value={run.executorId} mono />}
        {run.appVersion && <Field label="App version" value={run.appVersion} mono />}
        {(run.recoveryAttempts ?? 0) > 0 && (
          <Field label="Recovery attempts" value={String(run.recoveryAttempts)} />
        )}
      </dl>

      {/* Steps */}
      <section>
        <h3 className="mb-2 text-sm font-semibold">
          Steps {run.steps.length > 0 && `(${run.steps.length})`}
        </h3>
        {run.steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No journaled steps yet.</p>
        ) : (
          <ol className="space-y-1">
            {run.steps.map((s) => (
              <li
                key={s.functionID}
                className={cn(
                  'flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm',
                  s.error && 'border-destructive/40',
                )}
              >
                <span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">
                  {s.functionID}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                {s.childWorkflowID && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                    child
                  </span>
                )}
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatDuration(s.durationMs ?? null)}
                </span>
                {s.error && <span className="shrink-0 text-xs text-destructive">error</span>}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Input / output */}
      {run.input && <Payload label="Input" body={run.input} />}
      {run.output && <Payload label="Output" body={run.output} />}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={cn('truncate', mono && 'font-mono text-xs')}>{value}</dd>
    </div>
  );
}

function Payload({ label, body }: { label: string; body: string }) {
  return (
    <details className="rounded-md border border-border bg-muted/30">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-semibold">
        {label}
      </summary>
      <pre className="overflow-x-auto px-3 pb-3 text-xs scrollbar-thin">{body}</pre>
    </details>
  );
}

function ForkDialog({
  open,
  onOpenChange,
  run,
  onFork,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  run: RunnerRunDetail;
  onFork: (startStep: number) => void;
}) {
  const maxStep = run.steps.length;
  const [step, setStep] = useState('0');
  const n = Number(step);
  const valid = Number.isInteger(n) && n >= 0 && n <= maxStep;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fork from a step</DialogTitle>
          <DialogDescription>
            Creates a new run (new workflow id) that replays this run&apos;s completed steps up to
            the chosen step, then re-executes from there. The original run is untouched.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="fork-step">Start step (0–{maxStep})</Label>
          <Input
            id="fork-step"
            type="number"
            min={0}
            max={maxStep}
            value={step}
            onChange={(e) => setStep(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            0 forks from scratch. Step N reuses the results of steps before N.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid} onClick={() => onFork(n)}>
            <GitFork />
            Fork from step {valid ? n : '…'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-10 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-14 shrink-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {children}
    </Link>
  );
}

function PagerLink({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="size-7"
        disabled
        aria-label={label}
      >
        {children}
      </Button>
    );
  }
  return (
    <Button asChild size="icon" variant="outline" className="size-7">
      <Link href={href} aria-label={label}>
        {children}
      </Link>
    </Button>
  );
}
