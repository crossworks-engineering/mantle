import { requireOwner } from '@/lib/auth';
import { countFacts, listFacts } from '@/lib/debug';
import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { DebugPager, DebugSearchBox } from '@/components/debug/list-nav';
import { fmtRelative } from '../format';

const PAGE_SIZE = 50;

export default async function DebugFactsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const user = await requireOwner();
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || undefined;

  const [factRows, total] = await Promise.all([
    listFacts(user.id, { query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countFacts(user.id, { query }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Facts" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Extracted facts (profile)
        </h2>
        <DebugSearchBox placeholder="Search facts…" />
      </div>

      {factRows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          {query ? (
            'No facts match your search.'
          ) : (
            <>
              No facts yet. Set up an <code>extractor</code> agent at{' '}
              <a href="/settings/agents" className="underline">
                /settings/agents
              </a>{' '}
              and ingest some content (or run <code>pnpm extract:backfill</code>).
            </>
          )}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {factRows.map((f) => (
            <li key={f.id} className="px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span className="rounded-sm bg-muted px-1.5 py-0.5 uppercase tracking-wider">
                  {f.kind}
                </span>
                {f.entityName && (
                  <span>
                    <strong>{f.entityName}</strong>{' '}
                    <span className="text-muted-foreground/70">({f.entityKind})</span>
                  </span>
                )}
                {f.confidence < 1 && (
                  <span className="text-amber-700 dark:text-amber-300">
                    confidence {f.confidence.toFixed(2)}
                  </span>
                )}
                {f.sourceTitle && (
                  <span className="text-muted-foreground/70">← {f.sourceTitle.slice(0, 40)}</span>
                )}
                <span className="ml-auto">{fmtRelative(f.createdAt)}</span>
              </div>
              <p className="mt-1 text-sm">{f.content}</p>
            </li>
          ))}
        </ul>
      )}

      <DebugPager page={page} totalPages={totalPages} total={total} />
    </div>
  );
}
