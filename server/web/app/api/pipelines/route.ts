import { NextResponse } from '@/server/http-compat';
import type { PipelineList } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { listPipelines } from '@/lib/pipelines';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The settings area is the one check: only an Admin with it sees the
 *  pipelines. The handler asks nothing again. */
export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

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
