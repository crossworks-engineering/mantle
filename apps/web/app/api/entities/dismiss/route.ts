import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { dismissMergeCandidate } from '@mantle/content';

const Body = z.object({ idA: z.string().uuid(), idB: z.string().uuid() });

/** Record that two entities are NOT duplicates — never suggest the pair again. */
export async function POST(req: Request) {
  const user = await requireOwner();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'idA + idB (uuid) required' }, { status: 400 });
  }
  await dismissMergeCandidate(user.id, parsed.data.idA, parsed.data.idB);
  return NextResponse.json({ ok: true });
}
