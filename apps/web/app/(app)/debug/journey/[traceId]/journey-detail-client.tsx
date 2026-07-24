'use client';

import { useState } from 'react';
import { BookOpen, Boxes, Network, ScrollText, Square } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, apiSend, ApiError } from '@mantle/web-ui/api-fetch';
import { Button } from '@mantle/web-ui/ui/button';
import { useToast } from '@mantle/web-ui/ui/toast';
import { formatDateTime } from '@mantle/web-ui/lib/format-datetime';
import { formatDuration, formatMicroUsd } from '@/lib/traces-format';
import { deriveAction, sourceLabel } from '@/lib/journey-format';
import { ActionIcon } from '@/components/journey/action-icon';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { SetPageTitle } from '@/components/layout/page-title';
import type { JourneyDetail } from '@/lib/journey';

function strOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function stepDot(status: string): string {
  if (status === 'success') return 'bg-emerald-500';
  if (status === 'error') return 'bg-destructive';
  if (status === 'running') return 'bg-amber-500';
  if (status === 'skipped') return 'bg-muted-foreground/40';
  return 'bg-muted-foreground';
}

/**
 * Data-free journey detail. Fetches the reaction story from
 * GET /api/debug/journey/[traceId] and renders the step timeline + the brain
 * layers it produced, setting the page title once loaded.
 */
export function JourneyDetailClient({ traceId }: { traceId: string }) {
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  const journeyQuery = useQuery({
    queryKey: ['debug', 'journey', traceId],
    queryFn: () => apiFetch<{ journey: JourneyDetail }>(`/api/debug/journey/${traceId}`),
    retry: false,
    // A running journey keeps refreshing so the timeline grows live and the
    // status (and the Stop button) resolve without a manual reload.
    refetchInterval: (q) => (q.state.data?.journey.status === 'running' ? 3000 : false),
  });

  if (journeyQuery.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (journeyQuery.isError) {
    const notFound = journeyQuery.error instanceof ApiError && journeyQuery.error.status === 404;
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {notFound ? 'That journey no longer exists.' : "Couldn't load this journey."}
      </div>
    );
  }

  const j = journeyQuery.data.journey;
  const data = j.data ?? {};
  const source = strOf(data.source);
  const mime = strOf(data.mime) ?? strOf(data.mimeType);
  const pres = deriveAction({
    kind: j.kind,
    nodeType: j.landed?.node?.type ?? null,
    mime,
    source,
  });
  const subtitle = j.landed?.node?.title ?? strOf(data.filename) ?? strOf(data.title);
  // A running streamed turn carries its cancel handle in the trace data (see
  // startTrace). Traces without one (background ingest, heartbeats, pre-stamp
  // rows) simply don't get the button — there is nothing registered to abort.
  const turnId = strOf(data.turn_id);

  const stopTurn = async () => {
    if (!turnId || stopping) return;
    setStopping(true);
    try {
      await apiSend(`/api/assistant/turn/${turnId}/cancel`, 'POST');
      toast.info('Stop requested — the turn finalizes with its partial reply.');
      // The runner aborts asynchronously; the poll above picks up the flip.
      void journeyQuery.refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not request the stop');
      setStopping(false);
    }
  };

  return (
    <>
      {/* Action header */}
      <SetPageTitle title={pres.label} />
      <header className="flex items-start gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted">
          <ActionIcon iconKey={pres.iconKey} className="h-5 w-5 text-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
          <p className="mt-1 text-xs text-muted-foreground">
            <code className="font-mono">{j.kind}</code> · via {sourceLabel(source)} ·{' '}
            {formatDateTime(j.startedAt)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            <span
              className={
                j.status === 'error'
                  ? 'font-medium text-destructive'
                  : j.status === 'running'
                    ? 'font-medium text-amber-600 dark:text-amber-400'
                    : 'font-medium text-emerald-600 dark:text-emerald-400'
              }
            >
              {j.status}
            </span>{' '}
            · {j.stepCount} steps · {formatDuration(j.durationMs)} ·{' '}
            {formatMicroUsd(j.costMicroUsd)}
            {j.tokensIn + j.tokensOut > 0 && (
              <>
                {' '}
                · {j.tokensIn.toLocaleString()}↓ / {j.tokensOut.toLocaleString()}↑ tok
              </>
            )}
          </p>
          {j.error && (
            <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
              {j.error}
            </p>
          )}
        </div>
        {j.status === 'running' && turnId && (
          <Button
            size="sm"
            variant="destructive"
            className="shrink-0"
            disabled={stopping}
            onClick={stopTurn}
            title="Stop this turn — generation and pending tool calls halt; the partial reply is kept"
          >
            <Square />
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
        )}
      </header>

      {/* Step timeline */}
      <section className="space-y-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ScrollText className="h-4 w-4 text-muted-foreground" /> What happened
        </h2>
        {j.steps.length === 0 ? (
          <p className="text-xs text-muted-foreground">No steps recorded.</p>
        ) : (
          <ol className="space-y-0 border-l border-border pl-4">
            {j.steps.map((s) => {
              const out = s.output && Object.keys(s.output).length > 0 ? s.output : null;
              const meta = s.meta && Object.keys(s.meta).length > 0 ? s.meta : null;
              return (
                <li key={s.id} className="relative py-2">
                  <span
                    className={
                      'absolute -left-[1.30rem] top-3 h-2.5 w-2.5 rounded-full ' + stepDot(s.status)
                    }
                  />
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-mono text-sm">{s.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {s.kind}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {formatDuration(s.durationMs)}
                    </span>
                    {s.status === 'error' && (
                      <span className="text-[11px] font-medium text-destructive">failed</span>
                    )}
                    {s.status === 'skipped' && (
                      <span className="text-[11px] text-muted-foreground">skipped</span>
                    )}
                  </div>
                  {s.error && <p className="mt-1 text-xs text-destructive">{s.error}</p>}
                  {(out || meta) && (
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {JSON.stringify(out ?? meta)}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* Landed-in panel */}
      {j.landed ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Where it landed in your brain</h2>

          {/* L6 + L5 */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Boxes className="h-4 w-4 text-muted-foreground" /> L6 · Content store
              </div>
              {j.landed.node ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Stored as a <code className="font-mono">{j.landed.node.type}</code> node — the
                  immutable, citable source.
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">No node.</p>
              )}
            </div>

            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <BookOpen className="h-4 w-4 text-muted-foreground" /> L5 · Content index
              </div>
              {j.landed.index ? (
                <div className="mt-1 space-y-1 text-xs">
                  {j.landed.index.summary ? (
                    <p className="text-foreground">{j.landed.index.summary}</p>
                  ) : (
                    <p className="text-muted-foreground">No summary.</p>
                  )}
                  <p className="text-muted-foreground">
                    embedding {j.landed.index.hasEmbedding ? '✓' : '—'} · body text{' '}
                    {j.landed.index.hasText ? '✓' : '—'}
                  </p>
                  {j.landed.index.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {j.landed.index.tags.slice(0, 12).map((t) => (
                        <span
                          key={t}
                          className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">Not indexed.</p>
              )}
            </div>
          </div>

          {/* L4 facts */}
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ScrollText className="h-4 w-4 text-muted-foreground" /> L4 · Profile facts
              </div>
              <span className="text-xs text-muted-foreground">{j.landed.facts.length}</span>
            </div>
            {j.landed.facts.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">No facts mined.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {j.landed.facts.map((f, i) => (
                  <li key={i} className="text-xs">
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase text-muted-foreground">
                      {f.kind}
                    </span>{' '}
                    <span className="text-foreground">{f.content}</span>
                    {f.entityName && (
                      <span className="text-muted-foreground"> — {f.entityName}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Graph */}
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Network className="h-4 w-4 text-muted-foreground" /> Graph · Entities mentioned
              </div>
              <span className="text-xs text-muted-foreground">{j.landed.mentions.length}</span>
            </div>
            {j.landed.mentions.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">No entities linked.</p>
            ) : (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {j.landed.mentions.map((m, i) => (
                  <span
                    key={i}
                    className="rounded-full border border-border px-2 py-0.5 text-xs"
                    title={m.kind}
                  >
                    {m.name}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Graph · Relations */}
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Network className="h-4 w-4 text-muted-foreground" /> Graph · Relations drawn
              </div>
              <span className="text-xs text-muted-foreground">{j.landed.relations.length}</span>
            </div>
            {j.landed.relations.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">No relations drawn.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {j.landed.relations.map((r, i) => (
                  <li key={i} className="text-xs">
                    <span className="text-foreground">{r.subject}</span>{' '}
                    <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {r.relation}
                    </span>{' '}
                    <span className="text-foreground">{r.object}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : (
        <section className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
          This action didn’t produce a content node (it’s a {pres.category} action), so there’s no
          content-layer landing to show — just the steps above.
        </section>
      )}

      {/* Raw trace data */}
      {Object.keys(data).length > 0 && (
        <details className="rounded-lg border border-border p-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Raw trace data</summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
            {JSON.stringify(data, null, 2)}
          </pre>
        </details>
      )}
    </>
  );
}
