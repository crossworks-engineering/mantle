import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { setShareCascade } from '@/lib/shares';
import type { LoweredItem } from '@mantle/content';

const Body = z.object({ nodeId: z.string().uuid(), on: z.boolean() });

/**
 * POST /api/shares/cascade { nodeId, on } → turn subtree sharing ("Share
 * sub-pages") on/off for a page (owner-scoped). `on` shares every descendant
 * page at the parent's current mode; `off` revokes them. No-op if the page
 * isn't currently shared. `alsoLowered`: what the sub-pages embed that went
 * down with them. See docs/sharing.md.
 */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'nodeId and on required' }, { status: 400 });
  }
  const { nodeId, on } = parsed.data;
  const alsoLowered: LoweredItem[] = [];
  const result = await setShareCascade(user.id, nodeId, on, alsoLowered);
  if (!result.ok) return NextResponse.json({ error: 'node is not shared' }, { status: 409 });
  return NextResponse.json({ ok: true, count: result.count, alsoLowered });
}
