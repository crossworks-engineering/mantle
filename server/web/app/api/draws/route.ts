import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  countDraws,
  createDraw,
  listDrawTags,
  listDraws,
  sceneToText,
  type DrawSort,
} from '@/lib/draws';
import { recordIngest } from '@mantle/tracing';

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

  const [rows, total, tags] = await Promise.all([
    listDraws(user.id, { query, tag, sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countDraws(user.id, { query, tag }),
    listDrawTags(user.id),
  ]);
  return NextResponse.json({ draws: rows, total, page, pageSize: PAGE_SIZE, tags });
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
