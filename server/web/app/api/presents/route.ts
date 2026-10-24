/**
 * The Present workspace's items (docs/proposals/canvas-files.md): GET lists
 * canvases (flat, paginated; the folder view reads /api/tree/present), POST
 * makes one. A canvas is agent-written: the owner UI only reads it, and the
 * create here is for the agent tools' HTTP twin and for tests.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { capped } from '@/lib/list-workspaces';
import { ownerCaller } from '@/lib/auth';
import {
  compileCanvasCss,
  countPresents,
  createPresent,
  listPresents,
  type PresentSort,
} from '@/lib/presents';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
  POST: {
    class: 'content',
    open: 'owner',
    creates: true,
    item: { none: 'creates an item: ?ws= names where it lands' },
  },
});

const SORTS: PresentSort[] = ['edited', 'newest', 'oldest', 'title'];
const PAGE_SIZE = 50;

const CreateBody = z.object({
  title: z.string().max(200).optional(),
  source: z.string().max(1_100_000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

export async function GET(req: Request) {
  const user = ownerCaller();
  const sp = new URL(req.url).searchParams;
  const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1);
  const query = sp.get('q')?.trim() || undefined;
  const tag = sp.get('tag')?.trim() || undefined;
  const sortParam = sp.get('sort');
  const sort: PresentSort = SORTS.includes(sortParam as PresentSort)
    ? (sortParam as PresentSort)
    : 'edited';
  const [items, total] = await Promise.all([
    listPresents(user.id, {
      query,
      tag,
      sort,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countPresents(user.id, { query, tag }),
  ]);
  return NextResponse.json({ presents: await capped(items), total, page, pageSize: PAGE_SIZE });
}

export async function POST(req: Request) {
  const user = ownerCaller();
  const parsed = CreateBody.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const { title, source, tags } = parsed.data;
  const css = source !== undefined ? await compileCanvasCss(source) : '';
  const row = await createPresent(user.id, {
    ...(title !== undefined ? { title } : {}),
    ...(source !== undefined ? { source } : {}),
    css,
    tags,
  });
  return NextResponse.json({ present: row }, { status: 201 });
}
