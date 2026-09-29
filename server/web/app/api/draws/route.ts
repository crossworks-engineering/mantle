import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { listStateOf, pageWithPrivate } from '@/lib/admin-private-rows';
import {
  countDraws,
  createDraw,
  listDrawTags,
  listDraws,
  sceneToText,
  type DrawSort,
} from '@/lib/draws';
import { recordIngest } from '@mantle/tracing';
import { firstIssue } from '@/lib/zod-issue';

const SORTS: DrawSort[] = ['edited', 'newest', 'oldest', 'title'];
const PAGE_SIZE = 50;

/** An Excalidraw scene — an opaque object the canvas owns. Only its
 *  object-ness is validated here; `normalizeScene` (inside createDraw)
 *  whitelists what is actually stored. */
const SceneSchema = z.record(z.string(), z.unknown());

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  scene: SceneSchema.optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

/** The /draw list: flat, paginated, sorted (no nesting — a whiteboard list,
 *  not a tree). Always returns tag facet counts, mirroring /api/pages. */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const sp = new URL(req.url).searchParams;

  const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1);
  const query = sp.get('q')?.trim() || undefined;
  const tag = sp.get('tag')?.trim() || undefined;
  const sortParam = sp.get('sort');
  const sort: DrawSort = SORTS.includes(sortParam as DrawSort) ? (sortParam as DrawSort) : 'edited';

  // `?state=brain|private|all` adds the caller's own private drawings
  // (lib/admin-private-rows; default brain, the list as before).
  const [listed, tags] = await Promise.all([
    pageWithPrivate({
      user,
      kind: 'draw',
      state: listStateOf(sp),
      q: query,
      sort,
      tagged: !!tag,
      page,
      pageSize: PAGE_SIZE,
      brain: async (limit, offset) => {
        const [items, total] = await Promise.all([
          listDraws(user.id, { query, tag, sort, limit, offset }),
          countDraws(user.id, { query, tag }),
        ]);
        return { items, total };
      },
    }),
    listDrawTags(user.id),
  ]);
  return NextResponse.json({
    draws: listed.items,
    total: listed.total,
    page,
    pageSize: PAGE_SIZE,
    tags,
  });
}

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const row = await createDraw(user.id, parsed.data);
  const snippet = sceneToText(row.scene);
  void recordIngest({
    source: 'draw_create',
    ownerId: user.id,
    nodeId: row.id,
    summary: `Drawing created: ${row.title.slice(0, 80)}`,
    payload: { title: row.title, tags: row.tags, textChars: snippet.length, via: 'web_api' },
    snippet,
  });
  return NextResponse.json({ draw: row }, { status: 201 });
}
