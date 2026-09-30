import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { createRecallMap } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { countRecallMaps, listRecallMaps, recallWriteFailure } from '@/lib/recall';
import { firstIssue } from '@/lib/zod-issue';

const PAGE_SIZE = 20;

/** The Recall catalog: every map + its compile state, failed compiles
 *  included. URL-driven search + pagination (`q` / `page`) like the other
 *  list APIs; `total`/`page`/`pageSize` ride along for the client pager. */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim() || undefined;
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const [maps, total] = await Promise.all([
    listRecallMaps(user.id, { q, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countRecallMaps(user.id, q),
  ]);
  return NextResponse.json({ maps, total, page, pageSize: PAGE_SIZE });
}

const NewMap = z.object({
  title: z.string().min(1),
  enterWhen: z.string().min(1),
  folder: z.string().optional(),
});

/** Start a native (v2) map, with its entry card. Created PUBLISHED here: this
 *  is the owner's own surface, and the unpublished state exists for maps an
 *  agent proposes. */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = NewMap.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  try {
    const made = await createRecallMap(user.id, parsed.data, {
      kind: 'owner',
      id: user.actor.id,
      name: user.actor.displayName ?? null,
    });
    return NextResponse.json(made, { status: 201 });
  } catch (err) {
    return recallWriteFailure(err);
  }
}
