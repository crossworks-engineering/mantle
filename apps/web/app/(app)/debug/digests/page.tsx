import { requireOwner } from '@/lib/auth';
import { countDigests, listDigests } from '@/lib/debug';
import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { DebugPager, DebugSearchBox } from '@/components/debug/list-nav';
import { fmtRelative, fmtShort } from '../format';

const PAGE_SIZE = 25;

export default async function DebugDigestsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const user = await requireOwner();
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || undefined;

  const [digests, total] = await Promise.all([
    listDigests(user.id, { query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countDigests(user.id, { query }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Digests" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Conversation digests
        </h2>
        <DebugSearchBox placeholder="Search digests…" />
      </div>

      {digests.length === 0 ? (
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
    </div>
  );
}
