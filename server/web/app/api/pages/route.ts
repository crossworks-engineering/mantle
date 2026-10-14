import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { callerMayConfirm, callerMayReadEmail } from '@/lib/api-v1';
import { allPrivateRows, listStateOf, pageWithPrivate } from '@/lib/admin-private-rows';
import {
  countPages,
  createPage,
  docToText,
  listPageTags,
  listPages,
  PageFolderNotFoundError,
  ParentPageNotFoundError,
  type PageSort,
} from '@/lib/pages';
import { recordIngest } from '@mantle/tracing';
import { firstIssue } from '@/lib/zod-issue';
import { treeErrorResponse } from '@/lib/tree-route';
import { chipped, parseWsFilter } from '@/lib/list-workspaces';

const SORTS: PageSort[] = ['edited', 'newest', 'oldest', 'title'];
const PAGE_SIZE = 50;
// The unfiltered answer is the whole set at once (a personal KB is hundreds
// of pages, not thousands), the shape a client from before the pages tree
// reads. The flat/paginated path kicks in only when a search or tag filter
// is active.
const TREE_LIMIT = 2000;

/** A ProseMirror/TipTap document — an opaque object the editor owns. We only
 *  validate that it's an object here; `docToText` flattens it for the brain. */
const DocSchema = z.record(z.string(), z.unknown());

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  doc: DocSchema.optional(),
  icon: z.string().max(16).optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
  /** The folder of the pages tree the page goes in; null or absent is the
   *  top level (folder phase 7). */
  folderId: z.string().uuid().nullable().optional(),
  /** DEPRECATED (folder phase 7): pages do not nest. A page id here puts the
   *  new page in the same folder as that page. */
  parentId: z.string().uuid().optional(),
  /** A page in a shared folder is read at the folder's share at once, what
   *  it embeds with it: 409 `visibility` with the list until confirmed
   *  (docs/folder-tree.md, "Confirm first"). `seen`: the change count shown. */
  confirm: z.boolean().optional(),
  seen: z.number().int().min(0).optional(),
});

/**
 * The /pages list. Two shapes, matching the old server page:
 *   - filtering (q or tag): a flat, paginated, sorted list + `total` for the pager.
 *   - otherwise: every page (`mode: 'tree'`, up to TREE_LIMIT), the shape a
 *     client from before the pages tree reads (it built a hierarchy from
 *     `parentId`; every row's is null now, so it shows one flat list).
 * Always returns the tag facet counts so the filter UI needs no second request.
 * Where pages sit (their folders) is the pages tree's: `GET /api/tree/pages`.
 *
 * `?state=brain|private|all` (item-list alignment, lib/admin-private-rows):
 * `brain` (default) as always; `all` adds the caller's own private pages as
 * AdminPrivateListRow rows (top level in the tree, merged in the sort order
 * when filtering, none under a tag); `private` lists them alone.
 *
 * Every row carries its `workspaces` and `hasLink` (lib/list-workspaces).
 * `?ws=<id>` keeps only the pages that workspace reads (no private rows:
 * they are in no workspace) and is echoed as `ws`.
 */
export async function GET(req: Request) {
  const user = ownerCaller();
  const sp = new URL(req.url).searchParams;
  const ws = await parseWsFilter(req, user.id, user.actor.id);
  if (ws instanceof Response) return ws;
  const inWs = ws ? { ws } : {};

  const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1);
  const query = sp.get('q')?.trim() || undefined;
  const tag = sp.get('tag')?.trim() || undefined;
  const sortParam = sp.get('sort');
  const sort: PageSort = SORTS.includes(sortParam as PageSort) ? (sortParam as PageSort) : 'edited';
  const filtering = Boolean(query || tag);
  const asked = listStateOf(sp);
  // A private page is in no workspace: `?ws` lists brain pages only, and
  // none at all when only private ones were asked for.
  const none = ws !== null && asked === 'private';
  const state = ws ? 'brain' : asked;
  // A key without Search does not list a page made from an email
  // attachment (access matrix T4).
  const withoutEmailCopies = !callerMayReadEmail();

  const tagsPromise = listPageTags(user.id);

  if (filtering) {
    const [listed, tags] = await Promise.all([
      pageWithPrivate({
        user,
        kind: 'page',
        state,
        q: query,
        sort,
        tagged: !!tag,
        page,
        pageSize: PAGE_SIZE,
        brain: async (limit, offset) => {
          if (none) return { items: [], total: 0 };
          const [items, total] = await Promise.all([
            listPages(user.id, { query, tag, sort, limit, offset, withoutEmailCopies, ...inWs }),
            countPages(user.id, { query, tag, withoutEmailCopies, ...inWs }),
          ]);
          return { items, total };
        },
      }),
      tagsPromise,
    ]);
    return NextResponse.json({
      mode: 'list',
      pages: await chipped(user.id, user.actor.id, listed.items),
      total: listed.total,
      page,
      pageSize: PAGE_SIZE,
      tags,
      ...inWs,
    });
  }

  const [rows, privateRows, tags] = await Promise.all([
    state === 'private' || none
      ? []
      : listPages(user.id, { sort, limit: TREE_LIMIT, withoutEmailCopies, ...inWs }),
    state === 'brain' ? [] : allPrivateRows(user, 'page', { sort }),
    tagsPromise,
  ]);
  const pages = await chipped(user.id, user.actor.id, [...rows, ...privateRows]);
  return NextResponse.json({
    mode: 'tree',
    pages,
    total: pages.length,
    page: 1,
    pageSize: TREE_LIMIT,
    tags,
    ...inWs,
  });
}

export async function POST(req: Request) {
  const user = ownerCaller();
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  let row;
  try {
    // An API key never confirms a visibility change (lib/api-v1.ts).
    row = await createPage(user.id, {
      ...parsed.data,
      confirm: parsed.data.confirm === true && callerMayConfirm(),
    });
  } catch (err) {
    if (err instanceof PageFolderNotFoundError) {
      return NextResponse.json({ error: 'folder not found' }, { status: 400 });
    }
    if (err instanceof ParentPageNotFoundError) {
      return NextResponse.json({ error: 'parent page not found' }, { status: 400 });
    }
    // Who can see the page would change: 409 with the list (or busy).
    return treeErrorResponse(err);
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
