import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { mergeEntities } from '@mantle/content';

const Body = z.object({ canonicalId: z.string().uuid(), dupId: z.string().uuid() });

/** Merge dupId into canonicalId — re-points edges + facts, folds the variant
 *  in as an alias, deletes the dup. */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'canonicalId + dupId (uuid) required' }, { status: 400 });
  }
  const ok = await mergeEntities(user.id, parsed.data.canonicalId, parsed.data.dupId);
  if (!ok) return NextResponse.json({ error: 'entity not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
