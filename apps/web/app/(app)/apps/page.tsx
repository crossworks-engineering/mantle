import { requireOwner } from '@/lib/auth';
import { countApps, listApps, type AppSort } from '@mantle/content';
import { SetPageTitle } from '@/components/layout/page-title';
import { AppsClient } from './apps-client';

const SORTS: AppSort[] = ['edited', 'newest', 'oldest', 'title'];
const PAGE_SIZE = 50;

export default async function AppsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; sort?: string }>;
}) {
  const user = await requireOwner();
  const sp = await searchParams;

  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || undefined;
  const sort: AppSort = SORTS.includes(sp.sort as AppSort) ? (sp.sort as AppSort) : 'edited';

  const [apps, total] = await Promise.all([
    listApps(user.id, { query, sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countApps(user.id, { query }),
  ]);

  return (
    <>
      <SetPageTitle title="Apps" />
      <AppsClient
        apps={apps}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        query={query ?? ''}
        sort={sort}
      />
    </>
  );
}
