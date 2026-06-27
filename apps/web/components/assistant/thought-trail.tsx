'use client';

import { useState } from 'react';
import { ChevronRight, Globe, Search, Sparkles, Users, Wrench } from 'lucide-react';
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
};
function iconFor(kind: string) {
  return KIND_ICON[kind] ?? Wrench;
}

/**
 * The agent's "thought trail" — the grounded status steps of a turn, shown two
 * ways from one component:
 *   - `live`: builds during the turn (always expanded, the active step pulses).
 *   - record (default): the frozen trail under the finished reply, collapsed to
 *     a one-line summary you can expand. A lightweight, persistent record of what
 *     the agent did — no DB, no clutter.
 */
export function ThoughtTrail({
  steps,
  live = false,
  className,
}: {
  steps: ThoughtEvent[];
  live?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const expanded = live || open;
  const latest = steps[steps.length - 1]!;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-border/60 bg-muted/40 text-muted-foreground',
        className,
      )}
    >
      <button
        type="button"
        onClick={live ? undefined : () => setOpen((o) => !o)}
        aria-expanded={expanded}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left text-xs',
          !live && 'transition-colors hover:bg-foreground/[0.04]',
        )}
      >
        <Sparkles className={cn('size-3.5 shrink-0', live && 'animate-pulse')} aria-hidden />
        {live ? (
          <span className="truncate font-medium text-foreground/80">{latest.label}</span>
        ) : (
          <>
            <span className="font-medium">Thought process</span>
            <span className="opacity-60">
              · {steps.length} step{steps.length === 1 ? '' : 's'}
            </span>
            <ChevronRight
              className={cn('ml-auto size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
              aria-hidden
            />
          </>
        )}
      </button>

      {expanded && (
        <ol className="flex flex-col gap-1.5 px-3 pb-2.5 pt-0.5">
          {steps.map((s, i) => {
            const Icon = iconFor(s.kind);
            const isActive = live && i === steps.length - 1;
            return (
              <li key={i} className="flex items-center gap-2 text-xs">
                <Icon
                  className={cn('size-3.5 shrink-0 opacity-70', isActive && 'animate-pulse')}
                  aria-hidden
                />
                <span className={cn('min-w-0 truncate', isActive ? 'text-foreground/80' : 'opacity-80')}>
                  {s.label}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
