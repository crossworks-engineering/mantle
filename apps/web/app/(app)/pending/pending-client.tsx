'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

type PendingRow = {
  id: string;
  toolSlug: string;
  args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  agentId: string | null;
  traceId: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
};

export function PendingClient({ initialRows }: { initialRows: PendingRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<PendingRow[]>(initialRows);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => setRows(initialRows), [initialRows]);

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id);
    setError(undefined);
    try {
      const res = await fetch(`/api/pending/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? 'decision failed');
        return;
      }
      const data = (await res.json()) as { pending: PendingRow };
      setRows((prev) => prev.map((r) => (r.id === id ? data.pending : r)));
      startTransition(() => router.refresh());
    } finally {
      setBusyId(null);
    }
  };

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
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Awaiting decision
          </h2>
          <span className="text-xs text-muted-foreground">{pending.length}</span>
        </div>
        {pending.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
            Nothing pending. Tools marked <em>requires confirm</em> queue here when
            an agent proposes one.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {pending.map((r) => (
              <li key={r.id} className="space-y-2 px-3 py-3">
                <div className="flex items-baseline gap-2">
                  <code className="font-mono font-medium">{r.toolSlug}</code>
                  <span className="text-xs text-muted-foreground">
                    queued {fmtRelative(r.createdAt)}
                  </span>
                  {r.traceId && (
                    <a
                      href={`/traces/${r.traceId}`}
                      className="ml-auto text-xs underline text-muted-foreground hover:text-foreground"
                    >
                      ↗ originating trace
                    </a>
                  )}
                </div>
                {/* Heavy JSON payloads (tool calls with nested
                    objects) used to fill the page. Collapsed by
                    default with `details`; expand inline without
                    losing scroll position. */}
                <details className="rounded-md bg-muted/40 px-2 py-1 text-xs">
                  <summary className="cursor-pointer select-none font-mono text-muted-foreground hover:text-foreground">
                    args ({Object.keys(r.args ?? {}).length} field
                    {Object.keys(r.args ?? {}).length === 1 ? '' : 's'})
                  </summary>
                  <pre className="mt-1 max-h-64 overflow-auto font-mono">
                    {JSON.stringify(r.args, null, 2)}
                  </pre>
                </details>
                <div className="flex gap-2">
                  <Button
                    onClick={() => decide(r.id, 'approve')}
                    disabled={busyId === r.id}
                    size="sm"
                    className="bg-emerald-600 text-white hover:bg-emerald-700"
                  >
                    <Check /> Approve & run
                  </Button>
                  <Button
                    onClick={() => decide(r.id, 'reject')}
                    disabled={busyId === r.id}
                    size="sm"
                    variant="outline"
                  >
                    <X /> Reject
                  </Button>
                </div>
              </li>
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
                  <code className="font-mono font-medium text-foreground">
                    {r.toolSlug}
                  </code>
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

function fmtRelative(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-GB');
}
