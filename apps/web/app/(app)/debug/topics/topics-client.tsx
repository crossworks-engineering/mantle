'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import { Spinner } from '@/components/ui/spinner';
import { DebugPager, DebugSearchBox } from '@/components/debug/list-nav';
import { fmtRelative } from '../format';
import type { TopicRow } from '@/lib/debug';

const PAGE_SIZE = 25;

type TopicsData = { topics: TopicRow[]; total: number };

/** Data-free topics list: fetches GET /api/debug/topics keyed on the URL's page/q. */
export function TopicsClient({ page, query }: { page: number; query: string }) {
  const topicsQuery = useQuery({
    queryKey: ['debug', 'topics', { page, query }],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page) });
      if (query) p.set('q', query);
      return apiFetch<TopicsData>(`/api/debug/topics?${p.toString()}`);
    },
    placeholderData: (prev) => prev,
  });

  const topics = topicsQuery.data?.topics ?? [];
  const total = topicsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Conversation topics
        </h2>
        <DebugSearchBox placeholder="Search topics…" />
      </div>

      {topicsQuery.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : topicsQuery.isError ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          Couldn&apos;t load topics.
        </p>
      ) : topics.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          {query
            ? 'No topics match your search.'
            : 'No topics yet. They emerge as the summarizer rolls up undigested turns into named threads.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Topic</th>
                <th className="px-3 py-2 text-right font-semibold">Digests</th>
                <th className="px-3 py-2 text-right font-semibold">Turns</th>
                <th className="px-3 py-2 text-left font-semibold">First seen</th>
                <th className="px-3 py-2 text-left font-semibold">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {topics.map((t) => (
                <tr key={t.topicSlug || t.topic}>
                  <td className="px-3 py-2">
                    <span className="font-medium">{t.topic}</span>
                    {t.topicSlug && (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        topic:{t.topicSlug}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.digestCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.turnCount}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {fmtRelative(t.firstSeen)}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {fmtRelative(t.lastSeen)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <DebugPager page={page} totalPages={totalPages} total={total} />
    </>
  );
}
