import { NextResponse } from '@/server/http-compat';
import { emailAttachmentIds } from '@mantle/files';
import { fileProcessing } from '@mantle/tools';
import type { FileProcessing } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { callerMayReadEmail } from '@/lib/api-v1';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
});

/**
 * A file's processing, for the Details panel in Files (docs/files.md,
 * "Status and processing"): its status, size, pages, whether it was
 * embedded, the counts of chunks, facts and mentions, its database and the
 * pipeline that read it, the queue, the last error, and the items made from
 * it. The same answer as the `file_processing` tool (fileProcessing in
 * @mantle/tools). The read gate is the file's own: it is read in the
 * caller's scope, and a file the caller does not read is a 404, as on
 * GET /api/files/files/:id; an API key without the Search area does not
 * reach an email attachment (access matrix M4), as there.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  if (!callerMayReadEmail() && (await emailAttachmentIds(user.id, [id])).has(id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const answer = await fileProcessing(user.id, id);
  if (!answer) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(answer satisfies FileProcessing);
}
