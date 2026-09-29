import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { setShareCascade } from '@/lib/shares';
import { ClientLinkRetiredError, type LoweredItem, type ShareCascadeResult } from '@mantle/content';

const Body = z.object({ nodeId: z.string().uuid(), on: z.boolean() });

/**
 * POST /api/shares/cascade { nodeId, on } → turn subtree sharing ("Share
 * sub-pages") on/off for a page (owner-scoped). `on` shares every descendant
 * page at the parent's current mode, except a sub-page at client, which
 * keeps client and gets no link (`skipped`: their ids, client logins C1);
 * `off` revokes them. One transaction. No-op if the page isn't currently
 * shared; 400 `client-links-retired` for a client parent. `alsoLowered`:
 * what the sub-pages embed that went down with them. See docs/sharing.md.
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
  let result: ShareCascadeResult;
  try {
    result = await setShareCascade(user.id, nodeId, on, alsoLowered);
  } catch (err) {
    // A client page shares no sub-pages by link (client logins C1).
    if (err instanceof ClientLinkRetiredError) {
      return NextResponse.json({ error: err.message, reason: err.reason }, { status: 400 });
    }
    throw err;
  }
  if (!result.ok) return NextResponse.json({ error: 'node is not shared' }, { status: 409 });
  return NextResponse.json({
    ok: true,
    count: result.count,
    skipped: result.skipped,
    alsoLowered,
  });
}
