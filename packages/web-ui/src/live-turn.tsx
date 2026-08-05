'use client';

/**
 * Shared live-turn state + presentation for the TEAM surfaces (Team Chat and
 * the Forum topic view). Both clients tail /api/team/turn/[turnId]/stream with
 * near-identical SSE handlers; this module is the single event router so the
 * two can't drift (the drift already happened once: both kept ONE status
 * string, so every status event overwrote the last and the narrator's
 * paragraph vanished, and neither handled `reasoning-delta` at all).
 *
 * The owner assistant has its own richer machinery (use-turn-stream +
 * ThoughtTrail) — this is deliberately the lighter member-facing treatment.
 */
import { useState } from 'react';
import { ChevronRight, Sparkles } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';

/** One in-flight team turn as the member sees it. `status` is the CURRENT
 *  grounded activity line (each replaces the last — that's correct for tool
 *  ticks). `narration` is the narrator's warm first-person line: it only moves
 *  forward when a newer narrated event lands, so a plain status can never
 *  clear it. `reasoning` accumulates the model's streamed thinking. */
export type LiveTurn = {
  turnId: string;
  status: string | null;
  narration: string | null;
  reasoning: string;
  text: string;
};

export function emptyLiveTurn(turnId: string): LiveTurn {
  return { turnId, status: 'Thinking…', narration: null, reasoning: '', text: '' };
}

/** The subset of a turn event the team clients act on. Parsed loosely — the
 *  stream carries the full TurnEvent union but these surfaces only render
 *  status/narration, reasoning, and reply text (done/error stay caller-side,
 *  tied as they are to each view's reconcile flow). */
export type LiveTurnEvent = {
  type: string;
  data: { label?: string; text?: string; narrated?: boolean };
};

/** Fold one stream event into the live turn (pure — exported for tests).
 *  Narrated status → `narration` (persistent), plain status → `status`
 *  (replaced each step), reasoning-delta appends, text-delta appends and
 *  clears the grounded status line (the reply is now the show). Unhandled
 *  event types return the state unchanged. */
export function applyLiveTurnEvent(l: LiveTurn, event: LiveTurnEvent): LiveTurn {
  if (event.type === 'status' && event.data.label) {
    return event.data.narrated === true
      ? { ...l, narration: event.data.label }
      : { ...l, status: event.data.label };
  }
  if (event.type === 'reasoning-delta' && event.data.text) {
    return { ...l, reasoning: l.reasoning + event.data.text };
  }
  if (event.type === 'text-delta' && event.data.text) {
    return { ...l, status: null, text: l.text + event.data.text };
  }
  return l;
}

/** The narrator's persistent first-person line — italic, word-wrapped in full
 *  (narration can run to a short paragraph; truncating it defeats the point).
 *  Rendered above the typing indicator / streamed reply. */
export function NarrationLine({ text, className }: { text: string; className?: string }) {
  return (
    <p
      className={cn(
        'whitespace-pre-wrap break-words text-sm italic leading-relaxed text-muted-foreground',
        className,
      )}
    >
      {text}
    </p>
  );
}

/** The model's streamed reasoning behind a small collapsible — the same
 *  pattern as the owner assistant's ThinkingTrace, restyled standalone for the
 *  team surfaces. Collapsed by default; renders nothing without reasoning. */
export function ReasoningTrace({
  reasoning,
  className,
}: {
  reasoning: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const text = reasoning.trim();
  if (!text) return null;
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-left text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground"
      >
        <Sparkles className="size-3.5 shrink-0 opacity-70" aria-hidden />
        <span className="font-medium">Thinking</span>
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
      </button>
      {open && (
        <p className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap break-words pl-5 text-xs leading-relaxed text-muted-foreground/75">
          {text}
        </p>
      )}
    </div>
  );
}
