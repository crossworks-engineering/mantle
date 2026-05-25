import Link from 'next/link';
import { formatDateTime } from '@/lib/format-datetime';
import { formatDuration, formatMicroUsd, type TraceDetail as TraceDetailRow } from '@/lib/traces';
import { TraceDetail } from './[id]/trace-detail';

/** Shared trace detail surface — status + summary fields + step timeline.
 *  Used by the standalone /traces/[id] page and the /traces master-detail
 *  right pane. */
export function TraceDetailView({ trace }: { trace: TraceDetailRow }) {
  // Delegation links: a child agent trace carries parent_trace_id +
  // delegated_agent_slug in `data` (set by invoke-agent.ts). Surface
  // them so /traces is navigable across a delegation boundary.
  const parentTraceId =
    typeof trace.data.parent_trace_id === 'string' ? trace.data.parent_trace_id : null;
  const delegatedSlug =
    typeof trace.data.delegated_agent_slug === 'string' ? trace.data.delegated_agent_slug : null;

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">{trace.kind}</h2>
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
            value={trace.agentName ? `${trace.agentName} (${trace.agentSlug})` : '—'}
          />
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
          <Field label="ID" value={trace.id.slice(0, 8) + '…'} mono />
          {delegatedSlug && <Field label="Delegated agent" value={delegatedSlug} />}
          {parentTraceId && (
            <Field
              label="Parent trace"
              value={
                <Link
                  href={`/traces/${parentTraceId}`}
                  className="text-primary hover:underline"
                >
                  trace#{parentTraceId.slice(0, 8)} →
                </Link>
              }
            />
          )}
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
