import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { RECALL_LINE_MAX, RECALL_TITLE_MAX, createRecallMap } from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { parseWsFilter } from '@/lib/list-workspaces';
import { countRecallMaps, listRecallMaps, recallActorOf } from '@/lib/recall';
import { readBody } from '@/lib/read-body';
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

const PAGE_SIZE = 20;

/** The Recall catalog: every map, drafts and maps with no cards included.
 *  URL-driven search + pagination (`q` / `page`) like the other
 *  list APIs; `total`/`page`/`pageSize` ride along for the client pager. */
export async function GET(req: Request) {
  const user = ownerCaller();
  // `?ws=<id>` keeps only what that workspace reads (as the notes and apps
  // lists do), echoed as `ws`; a workspace the login cannot see is 404.
  const ws = await parseWsFilter(req, user.id, user.actor.id);
  if (ws instanceof Response) return ws;
  const inWs = ws ? { ws } : {};
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim() || undefined;
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const [maps, total] = await Promise.all([
    listRecallMaps(user.id, { q, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, ...inWs }),
    countRecallMaps(user.id, q, ws ?? undefined),
  ]);
  return NextResponse.json({ maps, total, page, pageSize: PAGE_SIZE, ...inWs });
}

const NewMap = z.object({
  title: z.string().min(1).max(RECALL_TITLE_MAX),
  enterWhen: z.string().min(1).max(RECALL_LINE_MAX),
  folder: z.string().optional(),
});

/** Start a native (v2) map, with its entry card. Created PUBLISHED here: this
 *  is the owner's own surface, and the unpublished state exists for maps an
 *  agent proposes. */
export async function POST(req: Request) {
  const user = ownerCaller();
  const body = await readBody(req, NewMap);
  const made = await createRecallMap(user.id, body, await recallActorOf(user));
  return NextResponse.json(made, { status: 201 });
}
