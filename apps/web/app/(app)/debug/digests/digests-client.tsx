'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import { Spinner } from '@/components/ui/spinner';
import { DebugPager, DebugSearchBox } from '@/components/debug/list-nav';
import { fmtRelative, fmtShort } from '../format';
import type { DigestRow } from '@/lib/debug';

const PAGE_SIZE = 25;

type DigestsData = { digests: DigestRow[]; total: number };

/** Data-free digests list: fetches GET /api/debug/digests keyed on the URL's
 *  page/q (the DebugSearchBox + DebugPager keep those in the URL). */
export function DigestsClient({ page, query }: { page: number; query: string }) {
  const digestsQuery = useQuery({
    queryKey: ['debug', 'digests', { page, query }],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page) });
      if (query) p.set('q', query);
      return apiFetch<DigestsData>(`/api/debug/digests?${p.toString()}`);
    },
    placeholderData: (prev) => prev,
  });

  const digests = digestsQuery.data?.digests ?? [];
  const total = digestsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Conversation digests
        </h2>
        <DebugSearchBox placeholder="Search digests…" />
      </div>

      {digestsQuery.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : digestsQuery.isError ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          Couldn&apos;t load digests.
        </p>
      ) : digests.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          {query
            ? 'No digests match your search.'
            : "No digests yet. Once a chat crosses the summarizer threshold, the summarizer agent produces one and it'll show up here."}
        </p>
      ) : (
        <ul className="space-y-3">
          {digests.map((d) => (
            <li key={d.id} className="rounded-md border border-border p-3 text-sm">
              {d.topic && <div className="mb-1 text-sm font-semibold">{d.topic}</div>}
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span className="font-mono">{d.telegramChatId ?? d.chatId.slice(0, 8)}</span>
                <span>·</span>
                <span>
                  {fmtShort(d.periodStart)} → {fmtShort(d.periodEnd)}
                </span>
                <span>·</span>
                <span>{d.sourceTurnCount} turns</span>
                <span>·</span>
                <span>
                  via <code className="font-mono">{d.model}</code>{' '}
                  {d.agent && <span>({d.agent})</span>}
                </span>
                <span className="ml-auto">{fmtRelative(d.createdAt)}</span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm">{d.summary}</p>
            </li>
          ))}
        </ul>
      )}

      <DebugPager page={page} totalPages={totalPages} total={total} />
    </>
  );
}
