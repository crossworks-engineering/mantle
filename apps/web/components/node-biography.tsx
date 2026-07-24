/**
 * Renders the full life story of a node: where it came from, every
 * pipeline that decided to run (or not run) on it, what each step
 * input/output looked like, where it stopped.
 *
 * Server component. Receives a fully-resolved NodeBiographyView from
 * the page-level loader; no client-side fetching here. Step input/
 * output rendering uses native <details> blocks (no JS needed) so the
 * page is fast and survives JS-off scenarios — important for a
 * "what did the system do?" debug surface that has to work when
 * other things are broken.
 */

import Link from 'next/link';
import { formatDateTime } from '@mantle/web-ui/lib/format-datetime';
import { formatDuration, formatMicroUsd } from '@/lib/traces-format';
import type { NodeBiographyView } from '@/lib/node-biography';
import type { TraceDetail, TraceStepSummary } from '@/lib/traces-format';

const KIND_LABELS: Record<string, string> = {
  content_ingest: 'Ingest',
  extractor_run: 'Extractor',
  summarizer_run: 'Summarizer',
  reflector_run: 'Reflector',
  responder_turn: 'Responder',
  photo_ingest: 'Photo ingest',
  manual: 'Manual',
};

const KIND_DESCRIPTIONS: Record<string, string> = {
  content_ingest: 'The data entered the system here. Snippet of what came in is in the step below.',
  extractor_run:
    'The extractor produces a summary, tags, and an embedding so this node becomes searchable.',
  summarizer_run:
    'The summarizer rolls older conversation turns into compact digests for memory tier 2.',
  reflector_run:
    'The reflector reviews recent activity and decides whether the persona notes need updating.',
  responder_turn: 'The responder LLM answered a user turn that referenced this node.',
  photo_ingest:
    'A photo arrived via Telegram and was routed through the vision worker before being saved as this node.',
  manual: 'A manually-issued trace.',
};

const STATUS_CHIP: Record<string, string> = {
  success:
    'rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300',
  error:
    'rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-destructive',
  skipped:
    'rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300',
  running:
    'rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-300',
};

export function NodeBiography({ view }: { view: NodeBiographyView }) {
  return (
    <div className="space-y-6">
      <NodeHeader view={view} />
      <Stats view={view} />
      <Timeline view={view} />
    </div>
  );
}

function NodeHeader({ view }: { view: NodeBiographyView }) {
  const n = view.node;
  return (
    <section className="rounded-lg border border-border bg-card p-4 text-sm">
      <header className="flex items-baseline justify-between gap-2 border-b border-border pb-2">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{n.title}</h2>
          <p className="text-xs text-muted-foreground">
            <code className="font-mono">{n.type}</code> · {n.path} · created{' '}
            {formatDateTime(n.createdAt)}
            {n.updatedAt !== n.createdAt && <> · updated {formatDateTime(n.updatedAt)}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span
            className={
              n.hasEmbedding
                ? 'rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300'
                : 'rounded bg-muted px-1.5 py-0.5 text-muted-foreground'
            }
            title={
              n.hasEmbedding
                ? 'Embedding present — node is searchable via vector retrieval.'
                : 'No embedding yet — extractor either has not run or skipped this node.'
            }
          >
            {n.hasEmbedding ? '✓ embedded' : '○ not embedded'}
          </span>
          <span
            className={
              n.summary
                ? 'rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300'
                : 'rounded bg-muted px-1.5 py-0.5 text-muted-foreground'
            }
            title={
              n.summary
                ? 'Extractor has written a summary; visible in retrieval results.'
                : 'No summary yet.'
            }
          >
            {n.summary ? '✓ summarised' : '○ no summary'}
          </span>
          <span
            className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
            title="Length of the content field used by the extractor."
          >
            {n.contentChars.toLocaleString()} chars
          </span>
        </div>
      </header>

      {n.summary && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
            Summary (from extractor)
          </summary>
          <p className="mt-2 whitespace-pre-wrap rounded bg-muted/40 px-3 py-2 text-xs">
            {n.summary}
          </p>
        </details>
      )}

      {n.contentPreview && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
            Content preview (first 4KB)
          </summary>
          <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-3 py-2 text-[11px] font-mono">
            {n.contentPreview}
          </pre>
        </details>
      )}

      {n.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1 text-[11px]">
          {n.tags.map((t) => (
            <span key={t} className="rounded bg-muted px-1.5 py-0.5 font-mono">
              #{t}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function Stats({ view }: { view: NodeBiographyView }) {
  const s = view.stats;
  return (
    <section className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      <StatTile label="Traces" value={String(s.totalTraces)} />
      <StatTile label="Cost" value={formatMicroUsd(s.totalCostMicroUsd)} />
      <StatTile
        label="Tokens"
        value={`${s.totalTokensIn.toLocaleString()} / ${s.totalTokensOut.toLocaleString()}`}
        title="Input / output tokens"
      />
      <StatTile
        label="Last touched"
        value={s.lastTouched === s.firstSeen ? 'never (after creation)' : timeAgo(s.lastTouched)}
        title={formatDateTime(s.lastTouched)}
      />
      {Object.keys(s.byStatus).length > 0 && (
        <div className="col-span-2 flex flex-wrap items-center gap-1.5 sm:col-span-4">
          <span className="text-muted-foreground">Status:</span>
          {Object.entries(s.byStatus).map(([status, n]) => (
            <span key={status} className={STATUS_CHIP[status] ?? STATUS_CHIP.running}>
              {n} {status}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function StatTile({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2" title={title}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

function Timeline({ view }: { view: NodeBiographyView }) {
  if (view.traces.length === 0) {
    return (
      <section className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm">
        <p className="font-medium">No traces yet for this node.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Either the node was created before tracing was wired (migration 0029) or no pipeline has
          touched it. The next extractor / summarizer / reflector pass will record here.
        </p>
      </section>
    );
  }
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">Timeline ({view.traces.length})</h2>
      <ol className="space-y-3">
        {view.traces.map((trace, i) => (
          <li key={trace.id}>
            <TraceCard trace={trace} index={i + 1} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function TraceCard({ trace, index }: { trace: TraceDetail; index: number }) {
  const label = KIND_LABELS[trace.kind] ?? trace.kind;
  const description = KIND_DESCRIPTIONS[trace.kind];
  const isSkipped = trace.status === 'skipped';
  const disposition =
    typeof trace.data?.disposition === 'string' ? (trace.data.disposition as string) : null;

  return (
    <article className="overflow-hidden rounded-md border border-border bg-card">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-3 py-2 text-xs">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground">#{index}</span>
            <span className="text-sm font-semibold">{label}</span>
            <span className={STATUS_CHIP[trace.status] ?? STATUS_CHIP.running}>{trace.status}</span>
            {trace.agentSlug && (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {trace.agentSlug}
              </code>
            )}
          </div>
          {description && <p className="text-muted-foreground">{description}</p>}
        </div>
        <div className="flex flex-col items-end gap-0.5 text-[11px] text-muted-foreground">
          <span title={formatDateTime(trace.startedAt)}>{timeAgo(trace.startedAt)}</span>
          <span>
            {formatDuration(trace.durationMs)}
            {trace.costMicroUsd > 0 && <> · {formatMicroUsd(trace.costMicroUsd)}</>}
          </span>
        </div>
      </header>

      {/* Skipped traces don't have steps — show the disposition prominently
          since that's the entire story. */}
      {isSkipped && disposition && (
        <div className="border-b border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
          <div className="font-semibold text-amber-700 dark:text-amber-300">
            Stopped here: <code className="font-mono">{disposition}</code>
          </div>
          {typeof trace.data?.hint === 'string' && (
            <p className="mt-1 text-amber-800/80 dark:text-amber-200/80">{trace.data.hint}</p>
          )}
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
              Full disposition payload
            </summary>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-background/60 px-2 py-1 text-[10px] font-mono">
              {JSON.stringify(trace.data, null, 2)}
            </pre>
          </details>
        </div>
      )}

      {/* error traces — show the error message prominently */}
      {trace.error && trace.status === 'error' && (
        <div className="border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
          <div className="font-semibold text-destructive">Failed: {trace.error}</div>
        </div>
      )}

      {/* Trace-level data block — shown above the steps so operators
          see the "what was this trace about" context first. */}
      {!isSkipped && Object.keys(trace.data).length > 0 && (
        <details className="border-b border-border px-3 py-2 text-xs">
          <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">
            Trace data
          </summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-2 py-1 text-[10px] font-mono">
            {JSON.stringify(trace.data, null, 2)}
          </pre>
        </details>
      )}

      {/* Steps */}
      {trace.steps.length > 0 && (
        <ol className="divide-y divide-border text-xs">
          {trace.steps.map((step, idx) => (
            <li key={step.id}>
              <StepRow step={step} index={idx + 1} />
            </li>
          ))}
        </ol>
      )}

      {/* Footer link to /traces/[id] for the full graph view */}
      <footer className="border-t border-border bg-muted/30 px-3 py-1.5 text-right text-[10px]">
        <Link href={`/traces/${trace.id}`} className="text-muted-foreground hover:text-foreground">
          Open in /traces →
        </Link>
      </footer>
    </article>
  );
}

function StepRow({ step, index }: { step: TraceStepSummary; index: number }) {
  return (
    <div className="px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground">{index}.</span>
          <span className="font-medium">{step.name}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {step.kind}
          </code>
          <span className={STATUS_CHIP[step.status] ?? STATUS_CHIP.running}>{step.status}</span>
        </div>
        <span className="text-[11px] text-muted-foreground">{formatDuration(step.durationMs)}</span>
      </div>
      {step.error && (
        <p className="mt-1 rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {step.error}
        </p>
      )}
      {/* Input / output / meta — collapsible. The "input" is named
          generously: it's whatever the caller threw on the step
          (often the LLM's prompt context, the bytes of an image,
          the query of a search). The biography view is where this
          becomes useful — the operator wants to SEE what went in. */}
      <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <PayloadBlock label="Input" payload={step.input} />
        <PayloadBlock label="Output" payload={step.output} />
        <PayloadBlock label="Meta" payload={step.meta} />
      </div>
    </div>
  );
}

function PayloadBlock({ label, payload }: { label: string; payload: Record<string, unknown> }) {
  if (!payload || Object.keys(payload).length === 0) {
    return (
      <div className="rounded border border-dashed border-border px-2 py-1 text-[10px] text-muted-foreground">
        {label}: (empty)
      </div>
    );
  }
  return (
    <details className="rounded border border-border bg-muted/30">
      <summary className="cursor-pointer px-2 py-1 text-[11px] font-medium hover:bg-muted/50">
        {label}{' '}
        <span className="text-muted-foreground">
          ({Object.keys(payload).length} field
          {Object.keys(payload).length === 1 ? '' : 's'})
        </span>
      </summary>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-border px-2 py-1.5 text-[10px] font-mono">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </details>
  );
}

/** Tiny relative-time formatter ("3m ago", "yesterday"). Avoiding a
 *  dependency on date-fns / luxon for a single use site. */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.round((now - then) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h ago`;
  const days = Math.round(sec / 86_400);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
