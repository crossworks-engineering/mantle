import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ClientLinkRetiredError, type LoweredItem } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { createShare, getActiveShareForNode } from '@/lib/shares';

/** GET /api/shares?nodeId=… → the node's active link (or null). `childCount`
 *  is always 0 and `cascade` always false since folder phase 7 (pages do
 *  not nest, so a link never shares sub-pages); both stay on the wire for
 *  clients from before the pages tree. */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const nodeId = new URL(req.url).searchParams.get('nodeId');
  if (!nodeId) return NextResponse.json({ error: 'nodeId required' }, { status: 400 });
  const share = await getActiveShareForNode(user.id, nodeId);
  const childCount = 0;
  return NextResponse.json({
    share: share
      ? {
          id: share.id,
          token: share.token,
          path: `/s/${share.token}`,
          mode: share.mode,
          cascade: share.cascade,
        }
      : null,
    childCount,
  });
}

const CreateBody = z.object({ nodeId: z.string().uuid() });

/** POST /api/shares { nodeId } → create (or return existing) active link. */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ error: 'valid nodeId required' }, { status: 400 });
  try {
    // The item's embeds go down with it (embedding means sharing).
    const alsoLowered: LoweredItem[] = [];
    const share = await createShare(user.id, parsed.data.nodeId, { alsoLowered });
    return NextResponse.json({
      share: { id: share.id, token: share.token, path: `/s/${share.token}`, mode: share.mode },
      alsoLowered,
    });
  } catch (err) {
    // A client item has no open link (client logins C1).
    if (err instanceof ClientLinkRetiredError) {
      return NextResponse.json({ error: err.message, reason: err.reason }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to create share' },
      { status: 400 },
    );
  }
}
