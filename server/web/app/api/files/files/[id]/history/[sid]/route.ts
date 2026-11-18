/**
 * DELETE /api/files/files/[id]/history/[sid]: delete one kept version of a
 * file (docs/files.md, "File history"). A Moderator's act, as a restore is:
 * a Moderator of the file's workspace, of a workspace that holds it, or an
 * Admin; never a plain user with Write on (deleteFileVersion asks it first).
 * Its bytes are removed by the store sweep a grace period later.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { deleteFileVersion } from '@mantle/files';
import { historyFileOrNull } from '@/lib/file-history-route';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The ids are uuids: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid', sid: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  DELETE: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'edit' },
  },
});

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const user = ownerCaller();
  const { id, sid } = await ctx.params;
  if (!(await historyFileOrNull(user.id, id))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  // The Moderator check first (a file the scope reads but does not
  // moderate: the 403 item-workspace by the one mapper).
  const ok = await deleteFileVersion(user.id, id, sid);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
