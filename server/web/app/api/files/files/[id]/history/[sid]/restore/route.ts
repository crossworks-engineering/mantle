/**
 * POST /api/files/files/[id]/history/[sid]/restore: a kept version's bytes
 * become the file's again (docs/files.md, "File history"). The bytes they
 * replace are kept as a new version, so a restore is undone by restoring
 * that one; the file is read again as for any new bytes. A Moderator of the
 * file's workspace, of a workspace that holds it, or an Admin; never a
 * plain user with Write on (restoreFileVersion asks it first). 409 when the
 * version's bytes are gone or do not match their record.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { restoreFileVersion } from '@mantle/files';
import type { FileRestoreResponse } from '@mantle/client-types';
import { historyFileOrNull } from '@/lib/file-history-route';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The ids are uuids: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid', sid: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'edit' },
  },
});

export async function POST(_req: Request, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const user = ownerCaller();
  const { id, sid } = await ctx.params;
  if (!(await historyFileOrNull(user.id, id))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const result = await restoreFileVersion(user.id, id, sid);
  if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({
    file: result.file,
    restored: result.restored,
  } satisfies FileRestoreResponse);
}
