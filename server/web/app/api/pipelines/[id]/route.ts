import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import type { PipelineRow } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { setPipeline } from '@/lib/pipelines';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The settings area is the one check: only an Admin with it changes a
 *  pipeline. The handler asks nothing again. */
export const policy = routePolicy({
  PATCH: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/** The two fields a set takes. Their values are checked by setPipelineState
 *  (checkOptions, the attach list), the same check as `pipeline_set`. */
const PatchBody = z
  .object({ options: z.unknown().optional(), workspaces: z.unknown().optional() })
  .strict();

/**
 * PATCH /api/pipelines/:id: set the options of one pipeline, or the
 * workspaces an `after` pipeline is attached to (docs/pipelines.md). The
 * body is a `PipelineSetBody`; the answer is the pipeline's row, with no
 * counts. A refused value is a 400 with its sentence. The MCP tool
 * `pipeline_set` does the same, through the same function.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const body = await readBody(req, PatchBody);
  const res = await setPipeline(user.id, user.actor.id, id, body);
  if (!res.ok) {
    return res.missing
      ? NextResponse.json({ error: 'no pipeline has that id' }, { status: 404 })
      : NextResponse.json({ error: res.error }, { status: 400 });
  }
  return NextResponse.json(res.row satisfies PipelineRow);
}
