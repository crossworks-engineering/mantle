'use client';

/**
 * The durable-run surface (slice 4 WP-B, promoted from /debug/runs). Master-
 * detail: left = the owner's runs (URL-driven selection + pagination); right =
 * the selected run's compiled item tree — the tree IS the audit log, this view
 * just renders `compileRunState`, plus the operator Cancel actuator and the
 * two "needs you" banners (budget pause / open question).
 */
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
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
} from '@/components/ui/alert-dialog';
import { useToast } from '@/components/ui/toast';
import { Spinner } from '@/components/ui/spinner';
import { ListPager } from '@/components/layout/list-pager';
import { useRealtime } from '@/components/realtime/use-realtime';
import { useListNav } from '@/lib/use-list-nav';
import { cn } from '@/lib/utils';

/** The realtime change type the migration-0135 `runs_changed` triggers reach
 *  the browser as (see apps/web/lib/realtime.ts). A literal, like every other
 *  `useRealtime` call site — importing the constant from `@mantle/runs` would
 *  drag the engine, drizzle and pg-boss into the client bundle. */
const RUN_CHANGE = 'run';

/** A run still doing something — the only states whose views change on their
 *  own, and so the only ones worth a safety-net poll. */
function isActiveStatus(status: string): boolean {
  return status === 'running' || status === 'paused';
}

type WorkerStat = {
  agentId: string | null;
  slug: string;
  name: string | null;
  model: string | null;
  accepted: number;
  redone: number;
  needsHuman: number;
  failed: number;
  unaudited: number;
  acceptanceRate: number | null;
};

type RunListEntry = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  costMicroUsd: number;
  itemCount: number;
};

type RunsListPayload = {
  enabled: boolean;
  page: number;
  pageSize: number;
  total: number;
  runs: RunListEntry[];
  workers: WorkerStat[];
};

type CompiledItem = {
  id: string;
  kind: string;
  state: string;
  label: string;
  outcome?: string;
  sideEffecting?: boolean;
  costMicroUsd: number;
  subtreeCostMicroUsd: number;
  traceRef?: string | null;
  supersededBy?: string | null;
  joinPolicy?: string | null;
  childrenDone?: number;
  childrenTotal?: number;
  children?: CompiledItem[];
};

type CompiledRun = {
  run: { id: string; title: string; status: string; createdAt: string; completedAt: string | null };
  tree: CompiledItem | null;
  totals: { items: number; byState: Record<string, number>; costMicroUsd: number };
};

const STATE_CLASS: Record<string, string> = {
  queued: 'text-muted-foreground',
  ready: 'text-chart-4',
  running: 'text-chart-1',
  paused: 'text-chart-4',
  done: 'text-chart-2',
  completed: 'text-chart-2',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground line-through',
  superseded: 'text-muted-foreground line-through',
};

function usd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

/** Recursively: does the tree hold an ask_human leaf still waiting (ready)? */
function hasOpenQuestion(item: CompiledItem | null): boolean {
  if (!item) return false;
  if (item.kind === 'ask_human' && item.state === 'ready') return true;
  return (item.children ?? []).some(hasOpenQuestion);
}

function ItemNode({ item, depth }: { item: CompiledItem; depth: number }) {
  const [open, setOpen] = useState(true);
  const isGroup = item.kind === 'group_seq' || item.kind === 'group_par';
  return (
    <div className={cn(depth > 0 && 'border-l border-border pl-3')}>
      <div className="flex flex-wrap items-baseline gap-x-2 py-0.5 text-sm">
        {isGroup ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="font-mono text-xs text-muted-foreground hover:text-foreground"
            aria-label={open ? 'Collapse group' : 'Expand group'}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">·</span>
        )}
        <span className={cn('font-mono text-xs uppercase', STATE_CLASS[item.state] ?? '')}>
          {item.state}
        </span>
        <span className="font-medium">{item.label}</span>
        {isGroup && (
          <span className="text-xs text-muted-foreground">
            {item.childrenDone}/{item.childrenTotal} · {item.joinPolicy}
          </span>
        )}
        {item.sideEffecting && (
          <span className="rounded bg-destructive/10 px-1 text-xs text-destructive">
            side-effecting
          </span>
        )}
        {item.subtreeCostMicroUsd > 0 && (
          <span className="text-xs text-muted-foreground">{usd(item.subtreeCostMicroUsd)}</span>
        )}
        {item.traceRef && (
          <a
            href={`/traces?selected=${item.traceRef}`}
            className="text-xs text-primary hover:underline"
          >
            trace
          </a>
        )}
      </div>
      {item.outcome && <div className="pl-6 text-xs text-muted-foreground">{item.outcome}</div>}
      {isGroup && open && (
        <div className="pl-2">
          {(item.children ?? []).map((c) => (
            <ItemNode key={c.id} item={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The operator Stop actuator — cancelRun via the run API (same semantics as
 *  the run_cancel tool; live even with MANTLE_RUNS off). */
function CancelRunButton({ runId, onCancelled }: { runId: string; onCancelled: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive" disabled={busy}>
          Cancel run
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this run?</AlertDialogTitle>
          <AlertDialogDescription>
            Pending and running items are cancelled; in-flight work finishes but its result is
            discarded. Open questions for this run expire. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep running</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              setBusy(true);
              apiSend<{ cancelled: boolean }>(`/api/runs/${runId}`, 'POST', { action: 'cancel' })
                .then((r) => {
                  toast.success(r.cancelled ? 'Run cancelled' : 'Run already finished');
                  onCancelled();
                })
                .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
          >
            Cancel run
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ['run', runId],
    queryFn: () => apiFetch<CompiledRun>(`/api/runs/${runId}`),
    // Safety net only — `runs_changed` does the repainting. LISTEN/NOTIFY has
    // no replayable backlog, so a change raised during a reconnect gap is
    // simply lost; on a terminal run that would strand the tree mid-flight
    // forever. Polls only while the run can still move.
    refetchInterval: (q) => (isActiveStatus(q.state.data?.run.status ?? '') ? 15_000 : false),
  });

  if (detailQuery.isError) {
    return (
      <p className="p-6 text-sm text-destructive">
        {detailQuery.error instanceof Error ? detailQuery.error.message : 'Could not load run.'}
      </p>
    );
  }
  if (detailQuery.isPending) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner /> Loading run…
      </div>
    );
  }
  const data = detailQuery.data;
  const active = data.run.status === 'running' || data.run.status === 'paused';
  const paused = data.run.status === 'paused';
  const waiting = hasOpenQuestion(data.tree);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['run', runId] });
    void queryClient.invalidateQueries({ queryKey: ['runs'] });
  };

  return (
    <div className="space-y-3 p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold">{data.run.title}</h2>
        <span className={cn('font-mono text-xs uppercase', STATE_CLASS[data.run.status] ?? '')}>
          {data.run.status}
        </span>
        <span className="text-xs text-muted-foreground">
          {data.totals.items} items · {usd(data.totals.costMicroUsd)}
        </span>
        {active && (
          <span className="ml-auto">
            <CancelRunButton runId={runId} onCancelled={refresh} />
          </span>
        )}
      </div>

      {paused && (
        <Link
          href="/pending"
          className="block rounded-md border border-chart-4/40 bg-chart-4/10 px-3 py-2 text-sm text-foreground hover:bg-chart-4/20"
        >
          <strong className="font-semibold">Budget exhausted.</strong> This run is paused — raise
          the budget or cancel it in Pending approvals ↗
        </Link>
      )}
      {waiting && (
        <Link
          href="/pending"
          className="block rounded-md border border-chart-4/40 bg-chart-4/10 px-3 py-2 text-sm text-foreground hover:bg-chart-4/20"
        >
          <strong className="font-semibold">Waiting on your answer.</strong> A step is blocked on a
          question — answer it in Pending approvals ↗
        </Link>
      )}

      <div className="rounded-md border border-border bg-card p-3">
        {data.tree ? (
          <ItemNode item={data.tree} depth={0} />
        ) : (
          <p className="text-sm text-muted-foreground">No items.</p>
        )}
      </div>
    </div>
  );
}

export function RunsClient() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { pending: navPending, go } = useListNav();
  const runParam = searchParams.get('run');
  const page = Math.max(1, Number(searchParams.get('page')) || 1);

  const listQuery = useQuery({
    queryKey: ['runs', page],
    queryFn: () => apiFetch<RunsListPayload>(`/api/runs?page=${page}`),
    // Safety net behind `runs_changed` — see RunDetail. Deliberately NOT
    // conditional on the list being non-empty: the state this screen most
    // needs to leave is the EMPTY one ("No runs yet" while a run is actually
    // being created), and a poll gated on current data can never leave it.
    refetchInterval: (q) =>
      (q.state.data?.runs ?? []).some((r) => isActiveStatus(r.status)) ? 15_000 : 60_000,
  });

  // The live repaint. One subscription for the whole screen: the prefix keys
  // cover the list (`['runs', page]`), every open detail (`['run', id]`) and
  // the strip's `['runs','active']`, so a run created, advanced or finished
  // anywhere — a chat turn, a queue worker, the sweep, another tab — lands
  // here without a reload.
  useRealtime([RUN_CHANGE], () => {
    void queryClient.invalidateQueries({ queryKey: ['runs'] });
    void queryClient.invalidateQueries({ queryKey: ['run'] });
  });

  if (listQuery.isError) {
    return (
      <p className="p-6 text-sm text-destructive">
        {listQuery.error instanceof Error ? listQuery.error.message : 'Could not load runs.'}
      </p>
    );
  }
  if (listQuery.isPending) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner /> Loading runs…
      </div>
    );
  }

  const { runs, total, pageSize, enabled, workers } = listQuery.data;
  // Auto-select the first row when the URL names none (no history push).
  const selected = runParam ?? runs[0]?.id ?? null;

  return (
    <div className="flex h-full flex-col">
      {enabled === false && (
        <p className="shrink-0 border-b border-border bg-muted px-4 py-2 text-sm text-muted-foreground">
          Runner queues are disabled on this brain (set <code>MANTLE_RUNS=1</code> to enable).
          Existing runs remain inspectable below.
        </p>
      )}
      {workers.length > 0 && (
        <div className="shrink-0 border-b border-border bg-card px-4 py-2">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Worker first-pass acceptance
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {workers.map((w) => (
              <span key={w.agentId ?? w.slug}>
                <span className="font-medium">{w.slug}</span>
                {w.model && <span className="text-muted-foreground"> ({w.model})</span>}{' '}
                {w.acceptanceRate != null ? `${Math.round(w.acceptanceRate * 100)}%` : '—'}{' '}
                <span className="text-muted-foreground">
                  ({w.accepted} accepted · {w.redone} redone
                  {w.needsHuman > 0 && ` · ${w.needsHuman} needs-human`} · {w.failed} failed
                  {w.unaudited > 0 && ` · ${w.unaudited} unaudited`})
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 md:grid md:grid-cols-[360px_1fr] md:overflow-hidden">
        {/* ── Left: run list ─────────────────────────────────────────── */}
        <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
          <div className="flex items-center justify-between gap-2 border-b border-border p-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Runs
            </h2>
            <span className="text-xs text-muted-foreground tabular-nums">{total}</span>
          </div>
          <div className="space-y-1.5 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
            {runs.length === 0 ? (
              <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
                No runs yet. The responder creates one with <code>run_plan</code> when it delegates
                a multi-step job.
              </p>
            ) : (
              runs.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => go({ run: r.id })}
                  className={cn(
                    'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                    selected === r.id && 'border-l-primary',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{r.title}</span>
                    <span
                      className={cn(
                        'ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wider',
                        STATE_CLASS[r.status] ?? 'text-muted-foreground',
                      )}
                    >
                      {r.status}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{new Date(r.createdAt).toLocaleString()}</span>
                    <span className="ml-auto tabular-nums">{usd(r.costMicroUsd)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
          <ListPager
            page={page}
            total={total}
            pageSize={pageSize}
            pending={navPending}
            onGo={(p) => go({ page: p, run: null })}
          />
        </div>

        {/* ── Right: run detail ──────────────────────────────────────── */}
        <div className="relative md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
          {selected ? (
            <RunDetail runId={selected} />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">Select a run to inspect it.</p>
          )}
        </div>
      </div>
    </div>
  );
}
