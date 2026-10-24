import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { dismissMergeCandidate } from '@mantle/content';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'content',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

const Body = z.object({ idA: z.string().uuid(), idB: z.string().uuid() });

/** Record that two entities are NOT duplicates — never suggest the pair again. */
export async function POST(req: Request) {
  const user = ownerCaller();
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'idA + idB (uuid) required' }, { status: 400 });
  }
  await dismissMergeCandidate(user.id, parsed.data.idA, parsed.data.idB);
  return NextResponse.json({ ok: true });
}
