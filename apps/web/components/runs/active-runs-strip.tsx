'use client';

/**
 * Active-runs strip (slice 4 WP-A) — a compact card per RUNNING/PAUSED run, so
 * the owner sees background work while chatting without leaving /assistant.
 * Self-contained: fetches `GET /api/runs?active=1` and polls every 5s while any
 * run is active (stops polling when the list empties). Renders NOTHING when
 * there are no active runs — zero visual cost on brains that don't use runs
 * (dark or not). No new realtime channel (runs have none); polling only.
 */
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

type ActiveRun = {
  id: string;
  title: string;
  status: string;
  spentMicroUsd: number;
  budgetMicroUsd: number | null;
  childrenDone: number;
  childrenTotal: number;
  waiting: boolean;
};

function usd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

function CancelActiveRun({ runId, onCancelled }: { runId: string; onCancelled: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
          disabled={busy}
        >
          Cancel
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

export function ActiveRunsStrip() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['runs', 'active'],
    queryFn: () => apiFetch<{ enabled: boolean; active: ActiveRun[] }>('/api/runs?active=1'),
    // Poll only while there is active work; stop when the list empties.
    refetchInterval: (q) => (q.state.data?.active.length ? 5000 : false),
  });

  const active = query.data?.active ?? [];
  if (active.length === 0) return null; // nothing running/paused → render nothing

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['runs', 'active'] });

  return (
    <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-border bg-muted/30 px-6 py-2">
      {active.map((r) => {
        const pct = r.childrenTotal > 0 ? Math.round((r.childrenDone / r.childrenTotal) * 100) : 0;
        return (
          <div
            key={r.id}
            className="flex min-w-56 shrink-0 flex-col gap-1 rounded-md border border-border bg-card px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{r.title}</span>
              {r.status === 'paused' && (
                <span className="shrink-0 rounded-sm bg-chart-4/20 px-1 text-[10px] uppercase tracking-wider text-chart-4">
                  paused
                </span>
              )}
              {r.waiting && (
                <span className="shrink-0 rounded-sm bg-chart-4/20 px-1 text-[10px] uppercase tracking-wider text-chart-4">
                  waiting
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {r.childrenDone}/{r.childrenTotal} steps
                {r.childrenTotal > 0 && ` · ${pct}%`}
              </span>
              <span className="tabular-nums">
                {usd(r.spentMicroUsd)}
                {r.budgetMicroUsd != null && ` / ${usd(r.budgetMicroUsd)}`}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Link
                href={`/runs?run=${r.id}`}
                className="text-xs text-primary underline-offset-2 hover:underline"
              >
                Open
              </Link>
              <span className="ml-auto">
                <CancelActiveRun runId={r.id} onCancelled={refresh} />
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
