'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Loader2,
  PanelRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatMicroUsd } from '@/lib/traces-format';
import { ActionIcon } from '@/components/journey/action-icon';
import {
  ageSeconds,
  relativeTime,
  STALL_THRESHOLD_S,
  useLiveActivity,
} from '@/components/journey/use-live-activity';
import type { ActivityItem } from '@/lib/journey';
import { formatElapsed } from './elapsed';

/**
 * Always-on Activity column in the app shell. Shows what's processing right now
 * (active-first, with stall detection), anything that recently failed, and the
 * stream of what entered the brain — human-labelled with outcome counts, not
 * raw trace kinds. Links into the Journey story. Polls /api/activity every 5s.
 *
 * Collapses to a narrow icon rail (`collapsed`): just status pips — running /
 * failed / recent counts — that expand the panel on click. Width tracks the
 * shell's `--activity-w` var so `main`/FleetLayout offsets stay in lockstep.
 */

/** "what entered the brain" — outcome summary for content actions. */
function outcomeText(it: ActivityItem): string | null {
  if (it.category !== 'content') return null;
  const parts: string[] = [];
  if (it.factCount > 0) parts.push(`${it.factCount} fact${it.factCount === 1 ? '' : 's'}`);
  if (it.mentionCount > 0)
    parts.push(`${it.mentionCount} ${it.mentionCount === 1 ? 'entity' : 'entities'}`);
  if (it.relationCount > 0)
    parts.push(`${it.relationCount} relation${it.relationCount === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'indexed';
}

/** A live, self-ticking elapsed timer for an in-flight item — counts up every
 *  second (independent of the 5s activity poll) so a long-running process still
 *  visibly progresses instead of looking frozen. */
function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{formatElapsed(ageSeconds(startedAt))}</>;
}

export function LiveColumn({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { data, loaded, tick } = useLiveActivity();
  void tick; // re-render cue for relative timestamps
  const active = data?.active ?? [];
  const failures = data?.failures ?? [];
  const recent = data?.recent ?? [];
  const live = active.length > 0;
  const hasAny = active.length + failures.length + recent.length > 0;

  return (
    <aside className="fixed top-0 bottom-[var(--footer-h)] right-0 z-30 hidden w-[var(--activity-w)] flex-col border-l bg-sidebar pt-16 transition-[width] duration-200 ease-in-out lg:flex">
      {collapsed ? (
        <CollapsedRail
          active={active.length}
          failures={failures.length}
          recent={recent.length}
          loaded={loaded}
          onToggle={onToggle}
        />
      ) : (
        <>
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Activity
                className={cn('size-4', live ? 'animate-pulse text-emerald-500' : 'text-muted-foreground')}
                aria-hidden
              />
              <h2 className="text-sm font-semibold">Activity</h2>
              {live && <span className="text-xs text-emerald-500">{active.length} live</span>}
            </div>
            <Link
              href="/debug/journey"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              View all
            </Link>
          </div>

          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {!loaded ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="size-5 animate-spin" aria-hidden />
              </div>
            ) : !hasAny ? (
              <div className="flex flex-col items-center justify-center px-4 py-12 text-center text-sm text-muted-foreground">
                <Activity className="mb-3 size-10 opacity-30" aria-hidden />
                <p className="font-medium">No recent activity</p>
                <p className="mt-1 text-xs">Agent runs, ingests, and heartbeats will stream in here.</p>
              </div>
            ) : (
              <>
                {active.length > 0 && (
                  <Section label="Active now">
                    {active.map((it) => {
                      const longRunning = ageSeconds(it.startedAt) > STALL_THRESHOLD_S;
                      return (
                        <Row key={it.traceId} it={it}>
                          <div className="flex items-center gap-2">
                            {/* Always spinning — a long-running process is busy,
                                not broken; the elapsed timer shows progress. */}
                            <Loader2 className="size-3.5 shrink-0 animate-spin text-emerald-500" aria-hidden />
                            <ActionIcon iconKey={it.iconKey} className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate text-sm font-medium">{it.label}</span>
                            <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                              <ElapsedTimer startedAt={it.startedAt} />
                            </span>
                          </div>
                          {longRunning && (
                            <div className="pl-5 text-xs text-muted-foreground">busy</div>
                          )}
                        </Row>
                      );
                    })}
                  </Section>
                )}

                {failures.length > 0 && (
                  <Section label="Needs attention">
                    {failures.map((it) => (
                      <Row key={it.traceId} it={it}>
                        <div className="flex items-center gap-2">
                          <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
                          <ActionIcon iconKey={it.iconKey} className="size-3.5 shrink-0 text-destructive" />
                          <span className="truncate text-sm font-medium">{it.label}</span>
                          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                            {relativeTime(it.startedAt)}
                          </span>
                        </div>
                        <div className="pl-5 text-xs text-destructive">failed</div>
                      </Row>
                    ))}
                  </Section>
                )}

                {recent.length > 0 && (
                  <Section label="Recent">
                    {recent.map((it) => {
                      const outcome = outcomeText(it);
                      return (
                        <Row key={it.traceId} it={it}>
                          <div className="flex items-center gap-2">
                            <ActionIcon iconKey={it.iconKey} className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate text-sm font-medium">{it.label}</span>
                            <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                              {relativeTime(it.startedAt)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 pl-5 text-xs text-muted-foreground">
                            {it.title && <span className="truncate">{it.title}</span>}
                            {outcome && (
                              <span className="ml-auto shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">
                                {outcome}
                              </span>
                            )}
                            {!outcome && it.costMicroUsd > 0 && (
                              <span className="ml-auto shrink-0 tabular-nums">
                                {formatMicroUsd(it.costMicroUsd)}
                              </span>
                            )}
                          </div>
                        </Row>
                      );
                    })}
                  </Section>
                )}
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

/** The collapsed icon rail: an expand button + busy / failed / done pips. */
function CollapsedRail({
  active,
  failures,
  recent,
  loaded,
  onToggle,
}: {
  active: number;
  failures: number;
  recent: number;
  loaded: boolean;
  onToggle: () => void;
}) {
  const idle = loaded && active + failures + recent === 0;
  return (
    <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto py-2 scrollbar-none">
      <button
        type="button"
        onClick={onToggle}
        aria-label="Expand activity"
        title="Expand activity (⌘J)"
        className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PanelRight className="size-4" aria-hidden />
      </button>
      <div className="my-1 h-px w-6 bg-border" />

      {!loaded && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}

      <StatusPip
        show={active > 0}
        count={active}
        title={`${active} running`}
        onClick={onToggle}
        icon={<Loader2 className="size-4 animate-spin text-emerald-500" aria-hidden />}
      />
      <StatusPip
        show={failures > 0}
        count={failures}
        title={`${failures} failed`}
        onClick={onToggle}
        icon={<AlertCircle className="size-4 text-destructive" aria-hidden />}
      />
      <StatusPip
        show={recent > 0}
        count={recent}
        title={`${recent} recently completed`}
        onClick={onToggle}
        icon={<CheckCircle2 className="size-4 text-muted-foreground" aria-hidden />}
      />

      {idle && (
        <Activity className="mt-1 size-4 text-muted-foreground opacity-30" aria-hidden />
      )}
    </div>
  );
}

function StatusPip({
  icon,
  count,
  title,
  onClick,
  show,
}: {
  icon: React.ReactNode;
  count: number;
  title: string;
  onClick: () => void;
  show: boolean;
}) {
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="relative flex size-9 items-center justify-center rounded-md transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {icon}
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground ring-2 ring-sidebar">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </button>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="sticky top-0 z-10 bg-sidebar/95 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
        {label}
      </div>
      <ul className="divide-y divide-border">{children}</ul>
    </div>
  );
}

function Row({ it, children }: { it: ActivityItem; children: React.ReactNode }) {
  return (
    <li>
      <Link
        href={`/debug/journey/${it.traceId}`}
        // Neutral foreground-overlay hover (not a colour tint): the column is
        // bg-sidebar (== muted in some themes, so bg-muted would be invisible),
        // and a coloured accent tint blends with the grey muted-foreground meta
        // text. A faint neutral overlay stays visible over any sidebar value in
        // light + dark while keeping the grey text legible.
        className="flex flex-col gap-0.5 px-4 py-2.5 transition-colors hover:bg-foreground/[0.06]"
      >
        {children}
      </Link>
    </li>
  );
}
