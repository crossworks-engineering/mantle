'use client';

/**
 * Read-only run view (slice 1): recent runs, click one to expand its
 * compiled item tree — states, one-line outcomes, costs, supersede chains.
 * The tree IS the audit log; this view just renders `compileRunState`.
 */
import { useEffect, useState } from 'react';
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
import { cn } from '@/lib/utils';

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
  done: 'text-chart-2',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground line-through',
  superseded: 'text-muted-foreground line-through',
};

function usd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
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

/** The operator Stop actuator — cancelRun via the debug API (same semantics
 *  as the run_cancel tool; live even with MANTLE_RUNS off). */
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
              apiSend<{ cancelled: boolean }>(`/api/debug/runs/${runId}`, 'POST', {
                action: 'cancel',
              })
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
  const [data, setData] = useState<CompiledRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    apiFetch<CompiledRun>(`/api/debug/runs/${runId}`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [runId, nonce]);
  if (error) return <p className="py-2 text-sm text-destructive">{error}</p>;
  if (!data)
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
        <Spinner /> Loading run…
      </div>
    );
  const active = data.run.status === 'running' || data.run.status === 'paused';
  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-x-3 text-sm">
        <span className="font-medium">{data.run.title}</span>
        <span className="text-xs text-muted-foreground">
          {data.totals.items} items · {usd(data.totals.costMicroUsd)}
        </span>
        {active && <CancelRunButton runId={runId} onCancelled={() => setNonce((n) => n + 1)} />}
      </div>
      {data.tree ? (
        <ItemNode item={data.tree} depth={0} />
      ) : (
        <p className="text-sm text-muted-foreground">No items.</p>
      )}
    </div>
  );
}

export function RunsClient() {
  const [runs, setRuns] = useState<RunListEntry[] | null>(null);
  const [workers, setWorkers] = useState<WorkerStat[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch<{ enabled: boolean; runs: RunListEntry[]; workers: WorkerStat[] }>('/api/debug/runs')
      .then((d) => {
        if (!alive) return;
        setRuns(d.runs);
        setWorkers(d.workers ?? []);
        setEnabled(d.enabled);
        if (d.runs.length > 0) setSelected(d.runs[0]!.id);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!runs)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading runs…
      </div>
    );

  return (
    <div className="space-y-4">
      {enabled === false && (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
          Runner queues are disabled on this brain (set <code>MANTLE_RUNS=1</code> to enable).
          Existing runs remain inspectable below.
        </p>
      )}
      {workers.length > 0 && (
        <div className="rounded-md border border-border bg-card p-3">
          <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">
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
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No runs yet. The responder creates one with <code>run_plan</code> when it delegates a
          multi-step job.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-4">Title</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Items</th>
                <th className="py-2 pr-4">Cost</th>
                <th className="py-2 pr-4">Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r.id)}
                  className={cn(
                    'cursor-pointer border-b border-border/50 hover:bg-accent hover:text-accent-foreground',
                    selected === r.id && 'bg-accent text-accent-foreground',
                  )}
                >
                  <td className="py-2 pr-4 font-medium">{r.title}</td>
                  <td className={cn('py-2 pr-4', STATE_CLASS[r.status] ?? '')}>{r.status}</td>
                  <td className="py-2 pr-4">{r.itemCount}</td>
                  <td className="py-2 pr-4">{usd(r.costMicroUsd)}</td>
                  <td className="py-2 pr-4 text-muted-foreground">
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && <RunDetail runId={selected} />}
    </div>
  );
}
