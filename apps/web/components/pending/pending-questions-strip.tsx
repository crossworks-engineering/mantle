'use client';

import { useMemo, useRef } from 'react';
import { HelpCircle } from 'lucide-react';
import { QuestionnaireCard, type CardDraft } from './questionnaire-card';
import { usePendingQuestions, useDecidePending } from './use-pending-questions';

/** Show at most this many inline; the rest are one click away on /pending.
 *  A chat thread buried under six questionnaires is worse than a pointer. */
const MAX_INLINE = 3;

/**
 * Open questions, answerable in the assistant thread itself.
 *
 * This is the surface the whole `ask_human` chain exists for: a background run
 * that stops to ask should be answerable where the operator already is —
 * beside the conversation — not only on a separate approvals screen. Renders
 * nothing when there are no questions, so it costs a brain that never uses
 * runs exactly one small fetch.
 */
export function PendingQuestionsStrip() {
  const { questions, invalidate } = usePendingQuestions();
  const { decide, busyId, error } = useDecidePending(invalidate);
  // In-progress answers, keyed by row id. Lives HERE because the strip stays
  // mounted while individual cards come and go — a card pushed out of the
  // visible slice by a newer question would otherwise take a half-filled
  // form down with it.
  const drafts = useRef<Map<string, CardDraft>>(new Map());

  // OLDEST FIRST (the API returns newest first). Existing cards then keep
  // their position as questions arrive, instead of every card shifting down
  // — you can't misclick a form that doesn't move under the cursor.
  const ordered = useMemo(() => [...questions].reverse(), [questions]);

  if (ordered.length === 0) return null;
  const shown = ordered.slice(0, MAX_INLINE);
  const hidden = ordered.length - shown.length;

  return (
    // Height-bounded + self-scrolling: three questionnaires are taller than the
    // viewport, and an unbounded strip pushes the composer off-screen entirely
    // (measured: 970px of a 972px panel). Questions are urgent, but never so
    // urgent that you lose the ability to type.
    <section
      aria-label="Questions waiting on you"
      className="max-h-[45vh] shrink-0 overflow-y-auto scrollbar-thin border-b border-border bg-muted/30 px-4 py-3"
    >
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <HelpCircle className="size-3.5" aria-hidden />
        {ordered.length === 1 ? 'A run needs your answer' : `${ordered.length} runs need you`}
      </h2>

      {error && (
        <p className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}

      <ul className="space-y-2">
        {shown.map((row) => (
          <li key={row.id} className="rounded-md border border-border bg-card">
            <QuestionnaireCard
              row={row}
              decide={decide}
              busy={busyId === row.id}
              compact
              draft={drafts.current.get(row.id)}
              onDraftChange={(d) => drafts.current.set(row.id, d)}
            />
          </li>
        ))}
      </ul>

      {hidden > 0 && (
        <a
          href="/pending"
          className="mt-2 inline-block text-xs underline text-muted-foreground hover:text-foreground"
        >
          {hidden} more waiting → /pending
        </a>
      )}
    </section>
  );
}
