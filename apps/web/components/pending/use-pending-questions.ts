'use client';

import { useCallback, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiFetch, apiSend, ApiError } from '@mantle/web-ui/api-fetch';
import { useRealtime } from '@/components/realtime/use-realtime';
import { isQuestionRow, type Decide, type PendingRow } from './types';

/** The app-wide open-questions slice. Distinct from `['pending']`, which
 *  /pending owns for its full list + history. */
export const PENDING_QUESTIONS_KEY = ['pending-questions'] as const;

/** Refresh BOTH pending views. Any decision — here, on /pending, from
 *  Telegram, in another tab — changes both, and a surface that missed the
 *  invalidation would show a question that is already answered. */
export function invalidatePending(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: PENDING_QUESTIONS_KEY }),
    queryClient.invalidateQueries({ queryKey: ['pending'] }),
  ]).then(() => undefined);
}

/**
 * The operator's open questions — runner `ask_human` gates and `run_budget`
 * pauses — wherever they need to appear (the assistant panel, the button
 * flash, the toast watcher).
 *
 * READ-ONLY and cheap to call from several places at once: every consumer
 * shares the one React Query entry, so N components cost ONE fetch. The live
 * repaint is subscribed exactly once by {@link usePendingQuestionsSync} —
 * `useRealtime` opens a dedicated SSE stream per call, and three components
 * each opening one would burn the browser's per-host connection budget for
 * no extra information.
 *
 * NO polling: `pending_tool_call` notifies drive the refresh, so a question
 * created by a background run (or answered from Telegram, or in another tab)
 * lands here within a notify. On brains with no questions this costs exactly
 * one small GET.
 *
 * Deliberately NOT gated on MANTLE_RUNS: the flag lives server-side, and any
 * future non-run questionnaire row would surface through the same queue.
 */
export function usePendingQuestions() {
  const queryClient = useQueryClient();
  const query = useQuery({
    // Its OWN key, deliberately not `['pending']`. This hook is mounted
    // app-wide (the footer button, the watcher, the panel strip) and wants a
    // narrow slice; /pending wants every row including history. Sharing one
    // key with two different queryFns would make the payload depend on which
    // observer happened to fetch first.
    queryKey: PENDING_QUESTIONS_KEY,
    // Narrow on the SERVER: only open rows, and only as many as could
    // plausibly be shown. The old `?limit=200` with no status filter shipped
    // every decided row's full args+result JSON to every page, just to
    // compute a count.
    queryFn: () => apiFetch<{ pending: PendingRow[] }>('/api/pending?status=pending&limit=50'),
  });

  const invalidate = useCallback(() => invalidatePending(queryClient), [queryClient]);

  const rows = query.data?.pending ?? [];
  const questions = rows.filter((r) => r.status === 'pending' && isQuestionRow(r));

  return {
    questions,
    count: questions.length,
    /** True only once real data has arrived. NOT `!isPending`: react-query's
     *  `isPending` is `status === 'pending'`, so a fetch that ERRORS with no
     *  data reports `isPending === false` while `questions` is still `[]` —
     *  a consumer treating that as "loaded, and there are none" would later
     *  see every pre-existing question as brand new. */
    hasLoaded: query.isSuccess,
    invalidate,
  };
}

/**
 * Subscribe the shared pending query to live changes. Mount ONCE, app-wide
 * (the shell's question watcher does) — every `usePendingQuestions` consumer
 * repaints off the same invalidation.
 */
export function usePendingQuestionsSync(): void {
  const queryClient = useQueryClient();
  const invalidate = useCallback(() => void invalidatePending(queryClient), [queryClient]);
  useRealtime(['pending_tool_call'], invalidate);
}

/**
 * The decision action, shared by every surface that renders a question card.
 * Owns its own busy/error state so a card can be dropped anywhere without the
 * host screen wiring mutation plumbing.
 */
export function useDecidePending(onSettled?: () => void | Promise<void>) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const decide = useCallback<Decide>(
    async (id, decision, payload) => {
      setBusyId(id);
      setError(undefined);
      try {
        await apiSend(`/api/pending/${id}`, 'PATCH', {
          decision,
          ...(payload?.answer ? { answer: payload.answer } : {}),
          ...(payload?.answers?.length ? { answers: payload.answers } : {}),
        });
        await onSettled?.();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'decision failed');
      } finally {
        setBusyId(null);
      }
    },
    [onSettled],
  );

  return { decide, busyId, error, setError };
}
