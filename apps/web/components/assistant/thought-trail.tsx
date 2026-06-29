'use client';

import { useEffect, useState } from 'react';
import {
  Calendar,
  ChevronRight,
  FileText,
  Globe,
  Pencil,
  Search,
  Send,
  Sparkles,
  Users,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ThoughtEvent } from './use-turn-stream';

/** Map a status `kind` to its trail icon. Unknown kinds fall back to the tool
 *  glyph (forward-compatible with new buckets / narrator output). */
const KIND_ICON: Record<string, typeof Sparkles> = {
  thinking: Sparkles,
  brain: Search,
  web: Globe,
  delegate: Users,
  tool: Wrench,
  write: Pencil,
  calendar: Calendar,
  message: Send,
  file: FileText,
};
function iconFor(kind: string) {
  return KIND_ICON[kind] ?? Wrench;
}

/** Map a status `kind` to a short, scannable category phrase shown in the trail's
 *  middle column ("searching web"). Unknown kinds fall back to the raw bucket. */
const KIND_PHRASE: Record<string, string> = {
  thinking: 'thinking',
  brain: 'searching brain',
  web: 'searching web',
  delegate: 'delegating',
  tool: 'running tool',
  write: 'writing',
  calendar: 'calendar',
  message: 'messaging',
  file: 'reading file',
};
function phraseFor(kind: string) {
  return KIND_PHRASE[kind] ?? kind;
}

/** The detail to show in the trail's third column. The category column already
 *  states the action ("searching web"), so when the label wraps its real
 *  argument in quotes ("Searching the web for “broccoli…”") we show just the
 *  argument, unquoted — no redundant "Searching the web for" lead-in. Labels
 *  with no quoted argument (narrated sentences) are shown in full. */
function detailFor(label: string): string {
  const m = label.match(/[“"']\s*([^“”"']+?)\s*[”"']/);
  return m ? m[1]! : label;
}

/** Tick `Date.now()` once a second while `active`, so the elapsed timer in the
 *  live footer advances. Idle (frozen record) pays nothing. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** "23s" under a minute, "1m 23s" above — the Claude-Code-style elapsed format. */
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s % 60).toString().padStart(2, '0')}s`;
}

/** Compact token count: "234", "1.2k", "15k". */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}

/** Local clock time ("2:34 PM") — shown on the frozen record so the turn is
 *  timestamped at a glance. Empty string for an unparseable value. */
function formatClock(ts: string | number | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The live "1m 23s · ~234 tokens · Thinking…" status line: a real elapsed
 *  timer, the streamed token estimate (or the real count once known), and the
 *  current activity label. Each metric is optional — without `startedAt`/`tokens`
 *  (e.g. the dock) it degrades to just the pulsing label. */
function StatusFooter({
  label,
  startedAt,
  tokens,
  tokensApprox,
  bordered,
}: {
  label: string;
  startedAt?: number | null;
  tokens?: number | null;
  tokensApprox?: boolean;
  bordered: boolean;
}) {
  const now = useNow(startedAt != null);
  const meta: string[] = [];
  if (startedAt != null) meta.push(formatElapsed(now - startedAt));
  if (tokens != null) meta.push(`${tokensApprox ? '~' : ''}${formatTokens(tokens)} tokens`);

  return (
    <div className={cn(bordered && 'mt-2.5 border-t border-border/40 pt-2.5')}>
      {/* The narrator line — the warm, prominent "what I'm doing right now",
          larger than the trail and shimmering while the turn runs. */}
      <div className="flex items-start gap-2">
        <Sparkles className="mt-[3px] size-4 shrink-0 animate-pulse text-foreground/50" aria-hidden />
        <p className="mantle-shimmer-text text-[0.95rem] font-medium leading-relaxed">{label}</p>
      </div>
      {meta.length > 0 && (
        <div className="mt-1 pl-6 text-[11px] tabular-nums text-muted-foreground/70">
          {meta.join(' · ')}
        </div>
      )}
    </div>
  );
}

/** One history step rendered as three top-aligned columns:
 *  `time | category | detail`. The detail (the full status label) word-wraps as
 *  a paragraph — never truncated — while the time and category stay on one line,
 *  so a long search query reads in full instead of being cut with an ellipsis. */
function TrailStepRow({ step, animate }: { step: ThoughtEvent; animate?: boolean }) {
  const Icon = iconFor(step.kind);
  return (
    <li
      className={cn(
        // A soft divider sits above every row but the first, separating each
        // historic thought. Equal margin above / padding below the line centres
        // it between thoughts, independent of the list's own gap.
        'mt-2.5 border-t border-border/25 pt-2.5 first:mt-0 first:border-t-0 first:pt-0',
        animate && 'mantle-trail-step',
      )}
    >
      {/* Header line: the category on the left, the elapsed time floated right. */}
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground/50">
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />
          <span className="truncate">{phraseFor(step.kind)}</span>
        </span>
        {step.elapsedMs != null && (
          <span className="shrink-0 tabular-nums">{formatElapsed(step.elapsedMs)}</span>
        )}
      </div>
      {/* Detail on its own line, wrapping in full — no truncation. */}
      <p className="mt-0.5 break-words text-sm leading-relaxed text-muted-foreground/75">
        {detailFor(step.label)}
      </p>
    </li>
  );
}

/**
 * The agent's "thought trail" — the grounded status steps of a turn, shown two
 * ways from one component:
 *   - `live`: builds during the turn. Completed steps stack above a single live
 *     footer line ("1m 23s · ~234 tokens · Thinking…") that shows the current
 *     activity plus a real elapsed timer and the streamed token estimate.
 *   - record (default): the frozen trail under the finished reply, collapsed to
 *     a one-line summary you can expand. A lightweight, persistent record of what
 *     the agent did — no DB, no clutter.
 */
export function ThoughtTrail({
  steps,
  live = false,
  mode = 'list',
  className,
  startedAt,
  tokens,
  tokensApprox,
  durationMs,
  timestamp,
}: {
  steps: ThoughtEvent[];
  live?: boolean;
  /** Live display: 'list' stacks completed actions above the active line
   *  (default); 'replace' shows ONLY the active line, each step replacing the
   *  last. No effect on the frozen record view. */
  mode?: 'list' | 'replace';
  className?: string;
  /** Live only: epoch ms the turn started, for the elapsed timer. */
  startedAt?: number | null;
  /** Live: streamed estimate / real output tokens for the footer. Record: the
   *  final total to show on the collapsed summary line. */
  tokens?: number | null;
  /** Live: marks `tokens` as the streamed estimate (renders a "~"). */
  tokensApprox?: boolean;
  /** Record only: total turn duration to show on the summary line. */
  durationMs?: number | null;
  /** Record only: when the turn landed, shown as a clock time on the summary. */
  timestamp?: string | number | Date | null;
}) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;

  // ── Live: completed ACTIONS stack above one active footer line ────────────
  if (live) {
    // Only real actions (searches, writes, delegations) persist as history —
    // "thinking" is transient, shown solely as the live footer line, so the
    // varied thinking phrases never pile up into a stack of filler. In 'replace'
    // mode we drop the stack entirely and show only the active line.
    const past = mode === 'replace' ? [] : steps.slice(0, -1).filter((s) => s.kind !== 'thinking');
    const active = steps[steps.length - 1]!;
    return (
      <div
        className={cn(
          'mantle-trail-step overflow-hidden rounded-xl border border-border/40 bg-muted/25 px-3.5 py-3 text-muted-foreground',
          className,
        )}
      >
        {past.length > 0 && (
          <ol className="flex flex-col">
            {past.map((s, i) => (
              <TrailStepRow key={`${i}-${s.label}`} step={s} animate />
            ))}
          </ol>
        )}
        <StatusFooter
          label={active.label}
          startedAt={startedAt}
          tokens={tokens}
          tokensApprox={tokensApprox}
          bordered={past.length > 0}
        />
      </div>
    );
  }

  // ── Record: collapsible one-line summary of the frozen trail ──────────────
  // Light by design — a quiet, timestamped footnote of what the turn did.
  const summary: string[] = [`${steps.length} step${steps.length === 1 ? '' : 's'}`];
  if (durationMs != null) summary.push(formatElapsed(durationMs));
  if (tokens != null) summary.push(`${formatTokens(tokens)} tokens`);
  const clock = timestamp != null ? formatClock(timestamp) : '';
  if (clock) summary.push(clock);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-border/40 bg-muted/20 text-muted-foreground/80',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-foreground/[0.04]"
      >
        <Sparkles className="size-3.5 shrink-0 opacity-70" aria-hidden />
        <span className="font-medium">Thought process</span>
        <span className="opacity-55">· {summary.join(' · ')}</span>
        <ChevronRight
          className={cn('ml-auto size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
      </button>

      {open && (
        <ol className="flex flex-col px-3 pb-2.5 pt-0.5">
          {steps.map((s, i) => (
            <TrailStepRow key={i} step={s} />
          ))}
        </ol>
      )}
    </div>
  );
}
