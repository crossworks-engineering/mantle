'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X, FlaskConical, AlertTriangle } from 'lucide-react';
import { apiFetch, apiSend, ApiError } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { QuestionnaireCard } from '@/components/pending/questionnaire-card';
import { invalidatePending } from '@/components/pending/use-pending-questions';
import { isQuestionRow, type Decide, type PendingRow } from '@/components/pending/types';

export function PendingClient({ devMode = false }: { devMode?: boolean }) {
  const queryClient = useQueryClient();
  const pendingQuery = useQuery({
    queryKey: ['pending'],
    queryFn: () => apiFetch<{ pending: PendingRow[] }>('/api/pending?limit=200'),
  });
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [queueing, setQueueing] = useState(false);

  // Both views: this screen's full list AND the app-wide open-questions slice
  // the assistant strip / button count read from.
  const invalidate = () => invalidatePending(queryClient);

  // This list stays live without its own SSE stream: the shell's
  // <PendingQuestionWatcher/> holds the one app-wide `pending_tool_call`
  // subscription and invalidates this very query key, so a decision made
  // elsewhere — a Telegram tap, another tab — still repaints here.

  const queueTestApproval = async () => {
    setQueueing(true);
    setError(undefined);
    try {
      await apiSend('/api/dev-tools/queue-approval', 'POST', {});
      await invalidate();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'could not queue test approval');
    } finally {
      setQueueing(false);
    }
  };

  const decide: Decide = async (id, decision, payload) => {
    setBusyId(id);
    setError(undefined);
    try {
      await apiSend(`/api/pending/${id}`, 'PATCH', {
        decision,
        ...(payload?.answer ? { answer: payload.answer } : {}),
        ...(payload?.answers?.length ? { answers: payload.answers } : {}),
      });
      await invalidate();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'decision failed');
    } finally {
      setBusyId(null);
    }
  };

  if (pendingQuery.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (pendingQuery.isError && !pendingQuery.data) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
        <p>Couldn&apos;t load pending approvals.</p>
        <Button variant="outline" size="sm" onClick={() => pendingQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const rows = pendingQuery.data.pending;
  const pending = rows.filter((r) => r.status === 'pending');
  const decided = rows.filter((r) => r.status !== 'pending');

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Awaiting decision
          </h2>
          <div className="flex items-center gap-3">
            {devMode && (
              <Button
                onClick={queueTestApproval}
                disabled={queueing}
                size="sm"
                variant="outline"
                title="Dev only: queue a harmless approval to exercise the live badge + Telegram card"
              >
                <FlaskConical /> Queue test approval
              </Button>
            )}
            <span className="text-xs text-muted-foreground">{pending.length}</span>
          </div>
        </div>
        {pending.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
            Nothing pending. Tools marked <em>requires confirm</em> queue here when an agent
            proposes one.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {pending.map((r) => (
              <PendingCard key={r.id} row={r} decide={decide} busy={busyId === r.id} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          History
        </h2>
        {decided.length === 0 ? (
          <p className="text-xs text-muted-foreground">No decisions yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {decided.map((r) => (
              <li key={r.id} className="space-y-1.5 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-baseline gap-2 text-xs">
                  <code className="font-mono font-medium text-foreground">{r.toolSlug}</code>
                  <span
                    className={
                      r.status === 'approved'
                        ? 'rounded-sm bg-emerald-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100'
                        : r.status === 'rejected'
                          ? 'rounded-sm bg-rose-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-rose-900 dark:bg-rose-900/40 dark:text-rose-100'
                          : 'rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground'
                    }
                  >
                    {r.status}
                  </span>
                  <span className="text-muted-foreground">
                    {r.decidedAt ? fmtRelative(r.decidedAt) : ''}
                  </span>
                </div>
                {r.error && (
                  <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                    {r.error}
                  </p>
                )}
                {r.result && (
                  <pre className="max-h-40 overflow-auto rounded-md bg-muted/40 px-2 py-1 text-[11px] font-mono">
                    {JSON.stringify(r.result, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * One pending row. A human-answerable gate — a runner `ask_human` question or
 * a `run_budget` pause — delegates to the SHARED <QuestionnaireCard/>, the
 * same component the assistant panel renders, so the two surfaces can never
 * drift apart. Everything else keeps the generic approve/reject +
 * collapsed-args view for ordinary confirm-gated tool calls.
 */
function PendingCard({ row, decide, busy }: { row: PendingRow; decide: Decide; busy: boolean }) {
  if (isQuestionRow(row)) {
    return (
      <li>
        <QuestionnaireCard row={row} decide={decide} busy={busy} />
      </li>
    );
  }

  return (
    <li className="space-y-2 px-3 py-3">
      {/* Bounced decision: the previous approve/reject reverted and must be
          re-made (settle-revert). Loud + first so it can't be missed. */}
      {row.error && (
        <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            <strong className="font-semibold">Previous decision bounced — decide again.</strong>{' '}
            {row.error}
          </span>
        </p>
      )}

      <div className="flex items-baseline gap-2">
        <code className="font-mono font-medium">{row.toolSlug}</code>
        <span className="text-xs text-muted-foreground">queued {fmtRelative(row.createdAt)}</span>
        {row.traceId && (
          <a
            href={`/traces/${row.traceId}`}
            className="ml-auto text-xs underline text-muted-foreground hover:text-foreground"
          >
            ↗ originating trace
          </a>
        )}
      </div>

      <details className="rounded-md bg-muted/40 px-2 py-1 text-xs">
        <summary className="cursor-pointer select-none font-mono text-muted-foreground hover:text-foreground">
          args ({Object.keys(row.args ?? {}).length} field
          {Object.keys(row.args ?? {}).length === 1 ? '' : 's'})
        </summary>
        <pre className="mt-1 max-h-64 overflow-auto font-mono">
          {JSON.stringify(row.args, null, 2)}
        </pre>
      </details>

      <div className="flex gap-2">
        <Button
          onClick={() => decide(row.id, 'approve')}
          disabled={busy}
          size="sm"
          className="bg-emerald-600 text-white hover:bg-emerald-700"
        >
          <Check /> Approve &amp; run
        </Button>
        <Button
          onClick={() => decide(row.id, 'reject')}
          disabled={busy}
          size="sm"
          variant="outline"
        >
          <X /> Reject
        </Button>
      </div>
    </li>
  );
}

function fmtRelative(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-GB');
}
