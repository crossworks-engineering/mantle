import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOwner } from '@/lib/auth';
import { getHeartbeat, listHeartbeatFires } from '@/lib/heartbeats';
import { formatInProfile } from '@mantle/content';
import { loadProfilePreferences } from '@mantle/content';
import { SetPageTitle } from '@/components/layout/page-title';

/**
 * /heartbeats/[id] — single-heartbeat biography.
 *
 * Shows current state (pretty-printed), schedule, gates, and the
 * last 50 fires (both successful + skipped). Each fire links to its
 * trace if one was opened (skips don't open traces — they only
 * record a heartbeat_fires row).
 */
export default async function HeartbeatDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireOwner();
  const [hb, fires, prefs] = await Promise.all([
    getHeartbeat(user.id, id),
    listHeartbeatFires(user.id, id, 50),
    loadProfilePreferences(user.id),
  ]);
  if (!hb) notFound();

  const fmt = (iso: string | null) => (iso ? formatInProfile(new Date(iso), prefs) : '—');

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <SetPageTitle title={hb.name} />
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <code className="text-sm text-muted-foreground">{hb.slug}</code>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase">
            {hb.status}
          </span>
        </div>
        {hb.description && <p className="text-sm text-muted-foreground">{hb.description}</p>}
        <p className="text-xs text-muted-foreground">
          <Link href="/settings/heartbeats" className="underline">← back to heartbeats</Link>
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2">
        <Card title="Agent">{hb.agentSlug}</Card>
        <Card title="Skill">{hb.skillSlug}</Card>
        <Card title="Surface">
          {hb.surface.kind === 'telegram' ? `Telegram chat ${hb.surface.chat_id}` : 'Web'}
        </Card>
        <Card title="Schedule">
          {hb.scheduleKind === 'interval' && hb.schedule.kind === 'interval' && (
            <>every {hb.schedule.every_minutes}min ±{hb.schedule.jitter_minutes ?? 0}min</>
          )}
          {hb.scheduleKind === 'once' && hb.schedule.kind === 'once' && <>once at {hb.schedule.at}</>}
          {hb.scheduleKind === 'manual' && <>manual only</>}
          {hb.scheduleKind === 'cron' && <>cron (unsupported v1)</>}
        </Card>
        <Card title="Next fire">{fmt(hb.nextFireAt)}</Card>
        <Card title="Last fired">{fmt(hb.lastFiredAt)}</Card>
        <Card title="Fire count">
          {hb.fireCount}
          {hb.maxFires != null && <span className="text-muted-foreground"> / {hb.maxFires}</span>}
        </Card>
        <Card title="Completion reason">
          <span className="font-mono text-xs">{hb.completionReason ?? '—'}</span>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Gates
        </h2>
        <ul className="space-y-1 text-sm">
          <li>min_idle_minutes: <code>{hb.minIdleMinutes ?? 'null'}</code></li>
          <li>cooldown_minutes: <code>{hb.cooldownMinutes ?? 'null'}</code></li>
          <li>
            quiet_hours:{' '}
            {hb.quietHours
              ? `${hb.quietHours.from}–${hb.quietHours.to} ${hb.quietHours.tz ?? '(profile tz)'}`
              : 'null'}
          </li>
          <li>earliest_at: <code>{hb.earliestAt ?? 'null'}</code></li>
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Current state
        </h2>
        <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs">
          {JSON.stringify(hb.state, null, 2)}
        </pre>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Recent fires ({fires.length})
        </h2>
        {fires.length === 0 && <p className="text-sm text-muted-foreground">No fires yet.</p>}
        <ul className="divide-y rounded-md border">
          {fires.map((f) => (
            <li key={f.id} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{fmt(f.firedAt)}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${dispositionClass(f.disposition)}`}>
                  {f.disposition}
                </span>
                {f.traceId && (
                  <Link href={`/traces/${f.traceId}`} className="text-xs underline">
                    trace →
                  </Link>
                )}
              </div>
              {f.replyText && (
                <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                  &ldquo;{f.replyText}&rdquo;
                </p>
              )}
              {f.errorMessage && (
                <p className="mt-1 text-xs text-rose-600">Error: {f.errorMessage}</p>
              )}
              {f.stateAfter && f.stateBefore && (
                <details className="mt-1 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">state diff</summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-2">
                    {`before: ${JSON.stringify(f.stateBefore)}\nafter:  ${JSON.stringify(f.stateAfter)}`}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

/** Disposition → tailwind class. Triage colour-coding:
 *    emerald = happy path (work done, user reached)
 *    sky     = milestone (heartbeat completed its goal)
 *    orange  = "we did the work but user got nothing" — needs surface attention
 *    rose    = blocking error needing operator attention (paused)
 *    purple  = transient runtime error (will retry on next tick)
 *    amber   = gate skip (everything fine, just not now) */
function dispositionClass(d: string): string {
  switch (d) {
    case 'fired':
      return 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100';
    case 'completed':
      return 'bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100';
    case 'fired_undelivered':
      return 'bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-100';
    case 'auto_paused':
      return 'bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-100';
    case 'error':
      return 'bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-100';
    default:
      // skipped_idle / skipped_quiet / skipped_cooldown / skipped_earliest
      return 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100';
  }
}
