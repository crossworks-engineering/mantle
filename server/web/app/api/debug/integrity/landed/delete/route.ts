import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';

import { getOwnerOr401 } from '@/lib/auth';
import { deleteLandedNode } from '@/lib/integrity/landed';
import { firstIssue } from '@/lib/zod-issue';

// Delete one real node + its brain footprint via the canonical cascade/reaper
// path. Owner-scoped; the destructive confirm lives in the client.

const Body = z.object({ nodeId: z.string().uuid() });

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const result = await deleteLandedNode(user.id, parsed.data.nodeId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'delete failed' }, { status: 400 });
  }
  return NextResponse.json(result);
}
