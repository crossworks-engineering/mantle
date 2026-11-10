/**
 * Send a task as a bug, a feature or a request (plan page 5559936a). Body
 * { kind: bug|feature|request, to: admin }. Send to Admin makes a copy in
 * this box's Admin workspace, with copies of the task's files. The person
 * makes the task and puts the files on it first, then sends it.
 *
 * Two checks: edit of the task (the gate, and submitTask's step), and the
 * task was not sent before (409).
 */
import { z } from 'zod';
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { submitTask } from '@mantle/content';
import { SUBMISSION_KINDS } from '@mantle/client-types/task-submissions';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';
import { submitTargets } from '@/lib/submit-targets';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: { class: 'content', open: 'owner', item: { param: 'id', need: 'edit' } },
});

const Body = z.object({ kind: z.enum(SUBMISSION_KINDS), to: z.enum(['admin', 'it']) }).strict();

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  if (!submitTargets().some((b) => b.to === parsed.data.to)) {
    return NextResponse.json({ error: 'this box has no Control Center' }, { status: 400 });
  }
  const task = await submitTask(user.id, id, {
    kind: parsed.data.kind,
    to: parsed.data.to,
    byLogin: user.actor.id,
  });
  if (!task) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ task });
}
