import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { runPipelines } from '@mantle/tools';
import type { PipelineRunAnswer } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { JSON_BODY_CEILING_BYTES } from '@/lib/body-limit';
import { readBody } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

/** Open to member logins, as the file's PATCH. \`item\` names what the write
 *  needs; the one rights check is runPipelines' own edit of the file
 *  (assertItemRight), before anything, as for the tool. */
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
 * POST /api/files/files/:id/run: run a built-in pipeline on one file
 * (docs/pipelines.md, "Run on demand"). With no `apply`, the dry run: the
 * pipelines that can run, with their counts. With `apply` and a
 * `pipeline`, each file it takes is queued. The answer is a
 * `PipelineRunAnswer`; a refused input is a 400 with its sentence. The MCP
 * tool `pipeline_run` does the same, through the same function, as does
 * POST /api/files/folders/:id/run, on the files of a folder.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  // A few fields, not a document: the JSON ceiling, not the Files one.
  const body = await readBody(req, Body, { maxBytes: JSON_BODY_CEILING_BYTES });
  const res = await runPipelines(user.id, { ...body, file_id: id });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(res.answer satisfies PipelineRunAnswer);
}
