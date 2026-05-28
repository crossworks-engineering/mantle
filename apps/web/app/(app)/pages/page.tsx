import { requireOwner } from '@/lib/auth';
import { countPages, listPageTags, listPages, type PageSort } from '@/lib/pages';
import { SetPageTitle } from '@/components/layout/page-title';
import { PagesClient } from './pages-client';

const SORTS: PageSort[] = ['edited', 'newest', 'oldest', 'title'];

const PAGE_SIZE = 50;
// Tree mode loads the whole hierarchy at once (a personal KB is hundreds of
// pages, not thousands). The flat/paginated path kicks in only when a search
// or tag filter is active — matches are scattered across the tree, so a flat
// result list is the right shape there (mirrors how Notion shows search).
const TREE_LIMIT = 2000;

export default async function PagesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; tag?: string; q?: string; sort?: string }>;
}) {
  const user = await requireOwner();
  const sp = await searchParams;

  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || undefined;
  const tag = sp.tag?.trim() || undefined;
  const sort: PageSort = SORTS.includes(sp.sort as PageSort) ? (sp.sort as PageSort) : 'edited';
  const filtering = Boolean(query || tag);

  const tagsPromise = listPageTags(user.id);

  if (filtering) {
    // Flat, paginated, filtered list.
    const [pages, total, tags] = await Promise.all([
      listPages(user.id, { query, tag, sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
      countPages(user.id, { query, tag }),
      tagsPromise,
    ]);
    return (
      <>
        <SetPageTitle title="Pages" />
        <PagesClient
          mode="list"
          pages={pages}
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

  // Tree mode — the whole hierarchy, built client-side from parent_id.
  const [pages, tags] = await Promise.all([
    listPages(user.id, { sort, limit: TREE_LIMIT }),
    tagsPromise,
  ]);
  return (
    <>
      <SetPageTitle title="Pages" />
      <PagesClient
        mode="tree"
        pages={pages}
        total={pages.length}
        page={1}
        pageSize={TREE_LIMIT}
        tags={tags}
        activeTag={null}
        query=""
        sort={sort}
      />
    </>
  );
}
