import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { notifyTreeChanged, placeTreeItem } from '@mantle/content/tree';
import { treeKindOr404 } from '@/lib/tree-route';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    limits: { rateLimit: ['treePlace'] },
    item: {
      none: 'the item it places and its folder: the item is named in the body, not the path; the handler asks the folder right',
    },
  },
});

const Body = z.object({
  id: z.string().uuid(),
  /** The item to follow in the folder's order; null = first. */
  after: z.string().uuid().nullable(),
});

/** POST /api/tree/:kind/place: put an item in its folder's custom order,
 *  directly after another item there (null = first). The order is one for
 *  everyone: Write on the folder sets it, an Admin scope at the top level
 *  (403 otherwise). Folders are placed with PATCH .../folders/:id `after`.
 *  Limited per login (treePlace): a place may rank a whole folder. */
export async function POST(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = ownerCaller();
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const body = await readBody(req, Body);
  await placeTreeItem(user.id, kind, body.id, body.after);
  await notifyTreeChanged(user.id, kind);
  return NextResponse.json({ ok: true });
}
