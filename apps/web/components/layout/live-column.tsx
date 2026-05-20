'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Activity, AlertCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatMicroUsd } from '@/lib/traces-format';

type Trace = {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  costMicroUsd: number;
  tokensIn: number;
  tokensOut: number;
  stepCount: number;
  agentName: string | null;
  agentSlug: string | null;
};

const KIND_LABEL: Record<string, string> = {
  responder_turn: 'Responder',
  extractor_run: 'Extractor',
  summarizer_run: 'Summarizer',
  reflector_run: 'Reflector',
  content_ingest: 'Ingest',
  photo_ingest: 'Photo',
  heartbeat_fire: 'Heartbeat',
  manual: 'Manual',
};

const POLL_MS = 5000;

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function LiveColumn() {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [, force] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    const fetchActivity = async () => {
      try {
        const res = await fetch('/api/activity', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { traces: Trace[] };
        if (alive) setTraces(data.traces);
      } catch {
        // network blip — keep last state, try again next tick
      } finally {
        if (alive) setLoaded(true);
      }
    };
    void fetchActivity();
    timer.current = setInterval(fetchActivity, POLL_MS);
    // Re-render every 15s so relative timestamps stay fresh.
    const ticker = setInterval(() => force((n) => n + 1), 15000);
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
      clearInterval(ticker);
    };
  }, []);

  const running = traces.some((t) => t.status === 'running');

  return (
    <aside className="fixed inset-y-0 right-0 z-30 hidden w-80 flex-col border-l bg-sidebar pt-16 lg:flex">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity
            className={cn('size-4', running ? 'animate-pulse text-primary' : 'text-muted-foreground')}
            aria-hidden
          />
          <h2 className="text-sm font-semibold">Activity</h2>
        </div>
        <Link href="/traces" className="text-xs text-muted-foreground hover:text-foreground">
          View all
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {!loaded ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" aria-hidden />
          </div>
        ) : traces.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-12 text-center text-sm text-muted-foreground">
            <Activity className="mb-3 size-10 opacity-30" aria-hidden />
            <p className="font-medium">No recent activity</p>
            <p className="mt-1 text-xs">
              Agent runs, ingests, and heartbeats will stream in here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {traces.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/traces/${t.id}`}
                  className="flex flex-col gap-1 px-4 py-2.5 transition-colors hover:bg-accent/50"
                >
                  <div className="flex items-center gap-2">
                    <StatusDot status={t.status} />
                    <span className="text-sm font-medium">{KIND_LABEL[t.kind] ?? t.kind}</span>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                      {relativeTime(t.startedAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 pl-4 text-xs text-muted-foreground">
                    <span className="truncate">{t.agentName ?? t.agentSlug ?? 'system'}</span>
                    {t.costMicroUsd > 0 && (
                      <span className="ml-auto tabular-nums">{formatMicroUsd(t.costMicroUsd)}</span>
                    )}
                  </div>
                  {t.status === 'error' && (
                    <div className="flex items-center gap-1 pl-4 text-xs text-destructive">
                      <AlertCircle className="size-3" aria-hidden /> failed
                    </div>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'success'
      ? 'bg-chart-2'
      : status === 'error'
        ? 'bg-destructive'
        : status === 'running'
          ? 'bg-primary animate-pulse'
          : 'bg-muted-foreground/40';
  return <span className={cn('size-2 shrink-0 rounded-full', color)} aria-label={status} />;
}
