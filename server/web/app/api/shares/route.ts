import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { assertMayLink, checkServeList } from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { createShare, getActiveShareForNode, SERVE_MAX } from '@/lib/shares';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'content' },
  POST: {
    class: 'content',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

/** GET /api/shares?nodeId=… → the node's active link (or null), with its
 *  served list (`served`, node ids, plan 8.1). `childCount` is always 0
 *  and `cascade` always false since folder phase 7 (pages do not nest, so a
 *  link never shares sub-pages); both stay on the wire for clients from
 *  before the pages tree. */
export async function GET(req: Request) {
  const user = ownerCaller();
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
          served: share.served,
        }
      : null,
    childCount,
  });
}

const CreateBody = z.object({
  nodeId: z.string().uuid(),
  serve: z.array(z.string().uuid()).max(SERVE_MAX).optional(),
});

/**
 * POST /api/shares { nodeId, serve? } → create (or return the existing)
 * open link, `{ share: { id, token, path, mode, served } }`. Who may: a
 * user who may edit the item (an app: a Moderator of its home), the Grant
 * Access panel's `mayLink`. `serve` (node ids) replaces the link's served
 * list: each id must be named or embedded by the item (a folder: sit in
 * it) and editable by the caller; ids the link already serves are kept
 * without a check. A link never changes a level or a grant.
 *
 * Refusals, `{ error, code }`: 404 `not_found` (an item the caller cannot
 * read, or a `serve` id it cannot read), 403 `forbidden` (may read but not
 * link, or a `serve` id it may not add), 400 `not_shareable`.
 */
export async function POST(req: Request) {
  const user = ownerCaller();
  const body = await readBody(req, CreateBody);
  const { nodeId, serve } = body;
  const item = await assertMayLink(user.id, user.actor.id, nodeId);
  const current = await getActiveShareForNode(user.id, nodeId);
  const list =
    serve === undefined
      ? undefined
      : await checkServeList(user.id, user.actor.id, item, serve, current?.served ?? []);
  const share = await createShare(user.id, nodeId, { serve: list });
  return NextResponse.json({
    share: {
      id: share.id,
      token: share.token,
      path: `/s/${share.token}`,
      mode: share.mode,
      served: share.served,
    },
  });
}
