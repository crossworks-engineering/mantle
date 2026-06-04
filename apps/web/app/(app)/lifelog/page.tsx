import { requireOwner } from '@/lib/auth';
import { countLifelogs, getLifelog, listLifelogTags, listLifelogs } from '@/lib/lifelog';
import { SetPageTitle } from '@/components/layout/page-title';
import { LifelogClient } from './lifelog-client';

const PAGE_SIZE = 50;

export default async function LifelogPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    q?: string;
    mood?: string;
    category?: string;
    tag?: string;
    selected?: string;
    edit?: string;
  }>;
}) {
  const user = await requireOwner();
  const sp = await searchParams;

  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || undefined;
  const mood = sp.mood?.trim() || undefined;
  const category = sp.category?.trim() || undefined;
  const tag = sp.tag?.trim() || undefined;
  const selectedId = sp.selected?.trim() || null;

  const [lifelogs, total, tags] = await Promise.all([
    listLifelogs(user.id, {
      query,
      mood,
      category,
      tag,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countLifelogs(user.id, { query, mood, category, tag }),
    listLifelogTags(user.id),
  ]);

  // Deep-link (`?selected=`) may point outside this page slice — fetch it so
  // the right pane can open it even when it's not in the list.
  const initialSelected =
    selectedId && !lifelogs.some((n) => n.id === selectedId)
      ? await getLifelog(user.id, selectedId)
      : null;

  return (
    <>
      <SetPageTitle title="Life Logs" />
      <LifelogClient
        entries={lifelogs}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        tags={tags}
        activeMood={mood ?? null}
        activeCategory={category ?? null}
        activeTag={tag ?? null}
        query={query ?? ''}
        initialSelectedId={selectedId}
        initialSelected={initialSelected}
        initialEditing={sp.edit === '1'}
      />
    </>
  );
}
