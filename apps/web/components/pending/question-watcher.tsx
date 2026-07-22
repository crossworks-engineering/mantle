'use client';

import { useEffect, useRef } from 'react';
import { useToast } from '@/components/ui/toast';
import { useAssistantDock } from '@/components/assistant/assistant-dock';
import { usePendingQuestions, usePendingQuestionsSync } from './use-pending-questions';
import { questionPreview, RUN_BUDGET_SLUG } from './types';

/**
 * Headless. Announces a NEW blocked-run question with a toast that opens the
 * assistant, where the questionnaire is waiting.
 *
 * A background run that parks on `ask_human` is invisible by nature — the
 * operator isn't watching /runs. The server side of this (the `pending_created`
 * fan-out) already lights the sidebar badge and pushes to the companion; this
 * is the in-app half: if you are looking at the app when a run stops to ask,
 * you find out immediately.
 *
 * Two deliberate quiet rules:
 *  - **Never toast on first load.** The initial fetch seeds the seen-set, so
 *    opening the app with three old questions waiting produces no toasts —
 *    only questions that ARRIVE while you're here.
 *  - **One toast per row, ever.** Ids are remembered for the session, so a
 *    refetch (realtime repaint, tab focus) can't re-announce the same
 *    question.
 */
export function PendingQuestionWatcher() {
  // The single app-wide live subscription for the shared pending query —
  // every other consumer (the button flash, the panel strip) reads its cache.
  usePendingQuestionsSync();
  const { questions, isPending } = usePendingQuestions();
  const toast = useToast();
  const { openAssistant } = useAssistantDock();

  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (isPending) return; // no data yet — nothing to compare against
    // First settled load: adopt whatever is already waiting as "seen".
    if (seen.current === null) {
      seen.current = new Set(questions.map((q) => q.id));
      return;
    }
    const fresh = questions.filter((q) => !seen.current!.has(q.id));
    for (const q of fresh) seen.current.add(q.id);
    // Answering elsewhere shrinks the list; ids stay in `seen` on purpose
    // (a re-appearing id is the same question, e.g. a bounced settle).
    for (const q of fresh) {
      const isBudget = q.toolSlug === RUN_BUDGET_SLUG;
      toast.push({
        kind: 'info',
        message: isBudget
          ? `Run paused — budget decision needed. ${questionPreview(q, 60)}`
          : `A run needs your answer: ${questionPreview(q)}`,
        // Sticky: a question is a block, not a notification you can miss by
        // looking away for six seconds.
        durationMs: 0,
        action: { label: 'Answer', onClick: () => openAssistant() },
      });
    }
  }, [questions, isPending, toast, openAssistant]);

  return null;
}
