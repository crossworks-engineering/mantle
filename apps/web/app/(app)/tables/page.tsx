import { requireOwner } from '@/lib/auth';
import { countTables, listTableTags, listTables, type TableSort } from '@/lib/tables';
import { SetPageTitle } from '@/components/layout/page-title';
import { TablesClient } from './tables-client';

const SORTS: TableSort[] = ['edited', 'newest', 'oldest', 'title'];
const PAGE_SIZE = 50;

export default async function TablesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; tag?: string; q?: string; sort?: string }>;
}) {
  const user = await requireOwner();
  const sp = await searchParams;

  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || undefined;
  const tag = sp.tag?.trim() || undefined;
  const sort: TableSort = SORTS.includes(sp.sort as TableSort) ? (sp.sort as TableSort) : 'edited';

  const [tables, total, tags] = await Promise.all([
    listTables(user.id, { query, tag, sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countTables(user.id, { query, tag }),
    listTableTags(user.id),
  ]);

  return (
    <>
      <SetPageTitle title="Tables" />
      <TablesClient
        tables={tables}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        tags={tags}
        activeTag={tag ?? null}
        query={query ?? ''}
        sort={sort}
      />
    </>
  );
}
