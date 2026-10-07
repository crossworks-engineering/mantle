/**
 * Public API v1 (lib/api-v1.ts).
 *
 * POST /api/v1/tasks/:id/comments { body } : add a comment to a TASK, as
 *      the calling login. The same handler as /api/nodes/:id/comments, held
 *      to tasks: a key limited to the tasks area must not comment on a page
 *      through this route.
 *
 * A comment on an item a client can read joins the client thread, which a
 * client reads (M2 audit, suspected item 3). A task cannot be read below
 * admin today (tasks are not a workspace kind: the nodes_audience_kind_ck
 * check), so this cannot happen; the route still refuses an API key on a
 * task that any share reaches, so a key never messages a client if that
 * ever changes.
 */
import { NextResponse } from '@/server/http-compat';
import { and, eq } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { isUuid } from '@mantle/std';
import { getOwnerOr401 } from '@/lib/auth';
import { isApiKeyRequest } from '@/lib/api-v1';
import { getTask } from '@/lib/tasks';
import { POST as commentOnNode } from '../../../../nodes/[id]/comments/route';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!isUuid(id) || !(await getTask(user.id, id))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (isApiKeyRequest()) {
    const [levels] = await db
      .select({
        audience: nodes.audience,
        inherited: nodes.inheritedLevel,
        embedded: nodes.embeddedLevel,
      })
      .from(nodes)
      .where(and(eq(nodes.id, id), eq(nodes.ownerId, user.id)))
      .limit(1);
    if (levels && (levels.audience !== 'admin' || levels.inherited || levels.embedded)) {
      return NextResponse.json(
        {
          error: 'forbidden',
          reason: 'key-shared-item',
          message: 'An API key cannot comment on an item that others can read.',
        },
        { status: 403 },
      );
    }
  }
  return commentOnNode(req, ctx);
}
