import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { runPipelines } from '@mantle/tools';
import type { PipelineRunAnswer } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

/** The one rights check: edit of the folder, for any login that may (open
 *  to member logins, as the folder's PATCH). The handler asks nothing again. */
export const policy = routePolicy({
  POST: {
    class: 'content',
    // A member who may edit the item runs it, not only a user of Admin.
    open: 'owner',
    item: { param: 'id', need: 'edit' },
  },
});

/** A PipelineRunBody. Its values are checked by runPipelines, the same
 *  check as `pipeline_run`. */
const Body = z
  .object({
    pipeline: z.string().max(40).optional(),
    apply: z.boolean().optional(),
    limit: z.number().optional(),
    after: z.string().max(40).optional(),
  })
  .strict();

/**
 * POST /api/files/folders/:id/run: run a built-in pipeline on the files of a folder and its sub-folders
 * (docs/pipelines.md, "Run on demand"). With no `apply`, the dry run: the
 * pipelines that can run, with their counts. With `apply` and a
 * `pipeline`, each file it takes is queued. The answer is a
 * `PipelineRunAnswer`; a refused input is a 400 with its sentence. The MCP
 * tool `pipeline_run` does the same, through the same function, as does
 * POST /api/files/files/:id/run, on one file.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const body = await readBody(req, Body);
  const res = await runPipelines(user.id, { ...body, folder_id: id });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(res.answer satisfies PipelineRunAnswer);
}
