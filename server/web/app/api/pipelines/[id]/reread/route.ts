import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import type { PipelineRunAnswer } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { JSON_BODY_CEILING_BYTES } from '@/lib/body-limit';
import { rereadPipeline } from '@/lib/pipelines';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The settings area is the one check: only an Admin with it reads the
 *  older files of a pipeline again. The handler asks nothing again. */
export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/** A PipelineRereadBody. Its values are checked by rereadPipeline, the same
 *  check as `pipeline_reread`. */
const Body = z
  .object({
    apply: z.boolean().optional(),
    limit: z.number().optional(),
    after: z.string().max(40).optional(),
  })
  .strict();

/**
 * POST /api/pipelines/:id/reread: read the older files of one pipeline
 * again (docs/pipelines.md, "Read the older files again"). With no `apply`,
 * the dry run: the older files found in this page, and nothing sent. With
 * `apply`, each file it takes is queued, after the busy check. The answer is
 * a `PipelineRunAnswer` with one choice. An unknown pipeline is a 404; a
 * refused input is a 400 with its sentence. The MCP tool `pipeline_reread`
 * does the same, through the same function.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  // A few fields, not a document: the JSON ceiling.
  const body = await readBody(req, Body, { maxBytes: JSON_BODY_CEILING_BYTES });
  const res = await rereadPipeline(user.id, id, body);
  if (!res.ok) {
    return res.missing
      ? NextResponse.json({ error: 'no pipeline has that id' }, { status: 404 })
      : NextResponse.json({ error: res.error }, { status: 400 });
  }
  return NextResponse.json(res.answer satisfies PipelineRunAnswer);
}
