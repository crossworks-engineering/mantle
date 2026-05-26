'use client';

import { useEffect, useRef, useState } from 'react';
import { Cpu, Database, HardDrive, MemoryStick } from 'lucide-react';
import type { SystemHealth } from '@/lib/system-health';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatBytes, formatPct, formatUptime } from '@/lib/format-bytes';
import { VitalsBar } from './vitals-bar';

const POLL_MS = 10_000;

/**
 * Live system vitals — the only fetching island on the dashboard. Polls
 * /api/health every ~10s, pauses while the tab is hidden, aborts in-flight
 * requests on each tick + unmount, and keeps the last good snapshot on error.
 */
export function SystemVitals() {
  const [data, setData] = useState<SystemHealth | null>(null);
  const [stale, setStale] = useState(false);
  const acRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function tick() {
      if (document.visibilityState === 'hidden') return;
      acRef.current?.abort();
      const ac = new AbortController();
      acRef.current = ac;
      try {
        const res = await fetch('/api/health', { cache: 'no-store', signal: ac.signal });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as SystemHealth;
        if (!cancelled) {
          setData(json);
          setStale(false);
        }
      } catch (err) {
        if (!cancelled && (err as Error).name !== 'AbortError') setStale(true);
      }
    }

    void tick();
    timer = setInterval(() => void tick(), POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      acRef.current?.abort();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  if (!data) return <SystemVitalsSkeleton />;

  const { host, postgres, storage, tika } = data;
  const memValue = host.mem ? `${formatBytes(host.mem.usedBytes)} / ${formatBytes(host.mem.totalBytes)}` : '—';
  const diskValue = host.disk ? `${formatBytes(host.disk.usedBytes)} / ${formatBytes(host.disk.totalBytes)}` : '—';

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">System vitals</CardTitle>
        <div className="flex items-center gap-1.5">
          <Pill ok={postgres.up} label="Postgres" />
          <Pill ok={storage.minioUp} label="MinIO" />
          <Pill ok={tika.up} label="Tika" title={tika.version ?? undefined} />
          <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
            {data.scope}
          </Badge>
          <span
            className={cn('size-2 rounded-full', stale ? 'bg-amber-500' : 'bg-emerald-500')}
            title={stale ? 'Last update failed — showing previous snapshot' : 'Live'}
            aria-hidden
          />
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* CPU */}
        <Tile icon={<Cpu className="size-4" />} title="CPU load">
          <VitalsBar pct={host.cpuLoadPct} value={formatPct(host.cpuLoadPct, true)} />
          <p className="text-xs text-muted-foreground">
            {host.cpuCores} cores · load {host.loadAvg.map((n) => n.toFixed(2)).join(' ')}
          </p>
        </Tile>
        {/* Memory */}
        <Tile icon={<MemoryStick className="size-4" />} title="Memory">
          <VitalsBar pct={host.mem?.usedPct ?? null} value={formatPct(host.mem?.usedPct ?? null, true)} />
          <p className="text-xs text-muted-foreground">{memValue}</p>
        </Tile>
        {/* Disk */}
        <Tile icon={<HardDrive className="size-4" />} title="Disk (files volume)">
          <VitalsBar pct={host.disk?.usedPct ?? null} value={formatPct(host.disk?.usedPct ?? null, true)} />
          <p className="truncate text-xs text-muted-foreground" title={host.disk?.mount}>
            {diskValue}
          </p>
        </Tile>
        {/* Postgres */}
        <Tile icon={<Database className="size-4" />} title="Postgres">
          <dl className="space-y-0.5 text-xs">
            <Row k="Size" v={formatBytes(postgres.dbSizeBytes)} />
            <Row k="Connections" v={postgres.connections?.toString() ?? '—'} />
            <Row k="Cache hit" v={formatPct(postgres.cacheHitPct, true)} />
          </dl>
        </Tile>
      </CardContent>
      <CardContent className="grid gap-x-6 gap-y-1 border-t pt-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <Row k="Process uptime" v={formatUptime(host.uptimeSec)} />
        <Row k="Heap" v={formatBytes(host.heapUsedBytes)} />
        <Row k="Attachment storage" v={formatBytes(storage.attachmentBytes)} />
        <Row k="RSS" v={formatBytes(host.rssBytes)} />
      </CardContent>
    </Card>
  );
}

function Pill({ ok, label, title }: { ok: boolean | null; label: string; title?: string }) {
  const tone =
    ok == null
      ? 'bg-muted text-muted-foreground'
      : ok
        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
        : 'bg-destructive/15 text-destructive';
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium', tone)}
      title={title}
    >
      <span className={cn('size-1.5 rounded-full', ok == null ? 'bg-muted-foreground' : ok ? 'bg-emerald-500' : 'bg-destructive')} />
      {label}
    </span>
  );
}

function Tile({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-medium tabular-nums">{v}</dd>
    </div>
  );
}

function SystemVitalsSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">System vitals</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
