import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { adminMergeEntities } from '@mantle/content';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'content',
    item: {
      none: 'entities, not items: the entity graph is the Admin workspace’s; only an Admin user reaches the route',
    },
  },
});

const Body = z.object({ canonicalId: z.string().uuid(), dupId: z.string().uuid() });

/** Merge dupId into canonicalId — re-points edges + facts, folds the variant
 *  in as an alias, deletes the dup. An Admin act: the definer
 *  mantle_entity_merge checks the Admin user inside (migration 0308). */
export async function POST(req: Request) {
  const user = ownerCaller();
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'canonicalId + dupId (uuid) required' }, { status: 400 });
  }
  const ok = await adminMergeEntities(user.actor.id, parsed.data.canonicalId, parsed.data.dupId);
  if (!ok) return NextResponse.json({ error: 'entity not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
