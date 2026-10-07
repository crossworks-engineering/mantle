/**
 * Public API v1 (lib/api-v1.ts).
 *
 * POST /api/v1/tasks/:id/comments { body } : add a comment to a TASK, as
 *      the calling login. The same handler as /api/nodes/:id/comments, held
 *      to tasks: a key limited to the tasks area must not comment on a page
 *      through this route.
 */
import { NextResponse } from '@/server/http-compat';
import { isUuid } from '@mantle/std';
import { getOwnerOr401 } from '@/lib/auth';
import { getTask } from '@/lib/tasks';
import { POST as commentOnNode } from '../../../../nodes/[id]/comments/route';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!isUuid(id) || !(await getTask(user.id, id))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return commentOnNode(req, ctx);
}
