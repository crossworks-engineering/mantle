import { requireOwner } from '@/lib/auth';
import { countTopics, listTopics } from '@/lib/debug';
import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { DebugPager, DebugSearchBox } from '@/components/debug/list-nav';
import { fmtRelative } from '../format';

const PAGE_SIZE = 25;

export default async function DebugTopicsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const user = await requireOwner();
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || undefined;

  const [topics, total] = await Promise.all([
    listTopics(user.id, { query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countTopics(user.id, { query }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Topics" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Conversation topics
        </h2>
        <DebugSearchBox placeholder="Search topics…" />
      </div>

      {topics.length === 0 ? (
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
    </div>
  );
}
