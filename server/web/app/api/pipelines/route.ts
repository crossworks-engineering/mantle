import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import type { PipelineInstallAnswer, PipelineList } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { installPipeline, listPipelines } from '@/lib/pipelines';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The settings area is the one check: only an Admin with it sees the
 *  pipelines, and installs one (owner, 2026-11-15: pipelines are an Admin
 *  feature; the Admin check is THE rule for add, change and remove). The
 *  handler asks nothing again. */
export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/** The whole package. Its files are checked by checkPackage, the same
 *  check as `pipeline_install`. */
const InstallBody = z.object({ files: z.unknown() }).strict();

/**
 * POST /api/pipelines: install an own pipeline (docs/pipelines.md, "Own
 * pipelines"). The body is a `PipelineInstallBody`; the answer a
 * `PipelineInstallAnswer`. A refusal is a 400 with its sentence. It starts
 * no run. The MCP tool `pipeline_install` does the same, through the same
 * function.
 */
export async function POST(req: Request) {
  const user = ownerCaller();
  const body = await readBody(req, InstallBody);
  const res = await installPipeline(user.id, user.actor.id, body);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(res.answer satisfies PipelineInstallAnswer);
}

/**
 * GET /api/pipelines: the Settings screen's list of the pipelines that read
 * files into their databases, with how many files each read and how many of
 * those at an older version (docs/pipelines.md). Numbers only, never a file.
 * The MCP tool `pipeline_list` gives the same list.
 */
export async function GET() {
  const user = ownerCaller();
  return NextResponse.json((await listPipelines(user.id)) satisfies PipelineList);
}
