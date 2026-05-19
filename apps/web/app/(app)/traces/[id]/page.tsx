import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOwner } from '@/lib/auth';
import { formatDateTime } from '@/lib/format-datetime';
import { formatDuration, formatMicroUsd, getTrace } from '@/lib/traces';
import { TraceDetail } from './trace-detail';

export default async function TraceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireOwner();
  const { id } = await params;
  const trace = await getTrace(user.id, id);
  if (!trace) notFound();

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <header className="space-y-2">
        <div className="flex items-baseline gap-3">
          <Link href="/traces" className="text-sm text-muted-foreground hover:underline">
            ← Traces
          </Link>
          <h1 className="text-2xl font-semibold">{trace.kind}</h1>
          <span
            className={
              trace.status === 'success'
                ? 'rounded-md bg-emerald-100 px-2 py-0.5 text-xs text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100'
                : trace.status === 'error'
                  ? 'rounded-md bg-destructive/20 px-2 py-0.5 text-xs text-destructive'
                  : 'rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100'
            }
          >
            {trace.status}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
          <Field label="Started" value={formatDateTime(trace.startedAt)} />
          <Field label="Duration" value={formatDuration(trace.durationMs)} />
          <Field
            label="Agent"
            value={
              trace.agentName ? `${trace.agentName} (${trace.agentSlug})` : '—'
            }
          />
          {/* When this trace was tied to a specific node, render the
              subject value as a link into the node-biography view so
              operators can pivot from "this one trace failed" to
              "show me everything that touched this node." */}
          {trace.subjectKind === 'node' && trace.subjectId ? (
            <Field
              label="Subject"
              value={
                <Link
                  href={`/nodes/${trace.subjectId}/history`}
                  className="text-primary hover:underline"
                >
                  node#{trace.subjectId.slice(0, 8)} →
                </Link>
              }
            />
          ) : trace.subjectKind === 'heartbeat' && trace.subjectId ? (
            // heartbeat_fire traces: pivot directly to the heartbeat
            // detail page (state + recent fires). Same idea as the
            // node-biography link above — operator can go from "this
            // one trace failed" to "show me the surrounding context".
            <Field
              label="Subject"
              value={
                <Link
                  href={`/heartbeats/${trace.subjectId}`}
                  className="text-primary hover:underline"
                >
                  heartbeat#{trace.subjectId.slice(0, 8)} →
                </Link>
              }
            />
          ) : (
            <Field
              label="Subject"
              value={
                trace.subjectKind
                  ? `${trace.subjectKind}#${(trace.subjectId ?? '').slice(0, 8)}`
                  : '—'
              }
            />
          )}
          <Field
            label="Tokens"
            value={`in ${trace.tokensIn} · out ${trace.tokensOut}${trace.tokensCacheRead > 0 ? ` · cache ${trace.tokensCacheRead}` : ''}`}
          />
          <Field label="Cost" value={formatMicroUsd(trace.costMicroUsd)} />
          <Field label="Steps" value={String(trace.stepCount)} />
          <Field
            label="ID"
            value={trace.id.slice(0, 8) + '…'}
            mono
          />
        </dl>
        {trace.error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {trace.error}
          </p>
        )}
      </header>

      <TraceDetail trace={trace} />
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  // ReactNode so callers can pass a Link for clickable subjects
  // (e.g. node subjects → /nodes/[id]/history). Plain strings still
  // render fine — JSX renders them as text.
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-xs' : 'text-sm'}>{value}</dd>
    </div>
  );
}
