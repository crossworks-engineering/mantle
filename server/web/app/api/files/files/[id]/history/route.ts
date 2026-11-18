/**
 * GET /api/files/files/[id]/history: a file's kept versions, newest first
 * (docs/files.md, "File history"), and whether the caller may restore or
 * delete one. Whoever reads the file reads its history; a file it does not
 * read is the 404 of none. See packages/files/src/file-history.ts.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { listFileVersions, mayModerateFile } from '@mantle/files';
import type { FileHistoryResponse } from '@mantle/client-types';
import { historyFileOrNull } from '@/lib/file-history-route';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  if (!(await historyFileOrNull(user.id, id))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const [versions, may] = await Promise.all([listFileVersions(user.id, id), mayModerateFile(id)]);
  return NextResponse.json({
    versions,
    rights: { mayRestore: may === true },
  } satisfies FileHistoryResponse);
}
