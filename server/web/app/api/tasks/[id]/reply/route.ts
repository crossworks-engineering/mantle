/**
 * Reply to a submission that arrived here (plan page 5559936a). Body
 * { note, version? }. The copy becomes done, and so does the person's own
 * task: at once on this box, in the next sweep from a Control Center. The
 * version defaults to this box's running version.
 *
 * Two checks: edit of the copy (the gate, and the step), and the copy has
 * no reply yet (409).
 */
import { z } from 'zod';
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { replyToSubmission } from '@mantle/content';
import { SUBMISSION_NOTE_MAX, SUBMISSION_VERSION_MAX } from '@mantle/client-types/task-submissions';
import { APP_VERSION } from '@mantle/client-types/version';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: { class: 'content', open: 'owner', item: { param: 'id', need: 'edit' } },
});

const Body = z
  .object({
    note: z.string().min(1).max(SUBMISSION_NOTE_MAX),
    version: z.string().max(SUBMISSION_VERSION_MAX).optional(),
  })
  .strict();

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const task = await replyToSubmission(user.id, id, {
    note: parsed.data.note,
    version: parsed.data.version?.trim() || APP_VERSION,
    byLogin: user.actor.id,
  });
  if (!task) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ task });
}
