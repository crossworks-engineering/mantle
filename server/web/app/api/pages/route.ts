import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  countPages,
  createPage,
  docToText,
  listPageTags,
  listPages,
  ParentPageNotFoundError,
  type PageSort,
} from '@/lib/pages';
import { recordIngest } from '@mantle/tracing';

const SORTS: PageSort[] = ['edited', 'newest', 'oldest', 'title'];
const PAGE_SIZE = 50;
// Tree mode loads the whole hierarchy at once (a personal KB is hundreds of
// pages, not thousands). The flat/paginated path kicks in only when a search or
// tag filter is active — mirrors the old server page.
const TREE_LIMIT = 2000;

/** A ProseMirror/TipTap document — an opaque object the editor owns. We only
 *  validate that it's an object here; `docToText` flattens it for the brain. */
const DocSchema = z.record(z.string(), z.unknown());

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  doc: DocSchema.optional(),
  icon: z.string().max(16).optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
  /** Optional parent page id — nests the new page as a sub-page (Phase 4a). */
  parentId: z.string().uuid().optional(),
});

/**
 * The /pages list. Two shapes, matching the old server page:
 *   - filtering (q or tag): a flat, paginated, sorted list + `total` for the pager.
 *   - otherwise: the whole hierarchy (`mode: 'tree'`, up to TREE_LIMIT), built
 *     client-side from parent_id.
 * Always returns the tag facet counts so the filter UI needs no second request.
 */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const sp = new URL(req.url).searchParams;

  const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1);
  const query = sp.get('q')?.trim() || undefined;
  const tag = sp.get('tag')?.trim() || undefined;
  const sortParam = sp.get('sort');
  const sort: PageSort = SORTS.includes(sortParam as PageSort) ? (sortParam as PageSort) : 'edited';
  const filtering = Boolean(query || tag);

  const tagsPromise = listPageTags(user.id);

  if (filtering) {
    const [pages, total, tags] = await Promise.all([
      listPages(user.id, { query, tag, sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
      countPages(user.id, { query, tag }),
      tagsPromise,
    ]);
    return NextResponse.json({ mode: 'list', pages, total, page, pageSize: PAGE_SIZE, tags });
  }

  const [pages, tags] = await Promise.all([
    listPages(user.id, { sort, limit: TREE_LIMIT }),
    tagsPromise,
  ]);
  return NextResponse.json({
    mode: 'tree',
    pages,
    total: pages.length,
    page: 1,
    pageSize: TREE_LIMIT,
    tags,
  });
}

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  let row;
  try {
    row = await createPage(user.id, parsed.data);
  } catch (err) {
    if (err instanceof ParentPageNotFoundError) {
      return NextResponse.json({ error: 'parent page not found' }, { status: 400 });
    }
    throw err;
  }
  const snippet = docToText(row.doc);
  void recordIngest({
    source: 'page_create',
    ownerId: user.id,
    nodeId: row.id,
    summary: `Page created: ${row.title.slice(0, 80)}`,
    payload: {
      title: row.title,
      tags: row.tags,
      textChars: snippet.length,
      via: 'web_api',
    },
    snippet,
  });
  return NextResponse.json({ page: row }, { status: 201 });
}
