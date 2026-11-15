import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { pipelinePackage } from '@/lib/pipelines';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The settings area is the one check: only an Admin with it reads a
 *  package. The handler asks nothing again. */
export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/**
 * GET /api/pipelines/:id/package: the package of an own pipeline
 * (docs/pipelines.md, "Own pipelines"): `{ id, version, files }`, to read
 * it or change it and install it again. No such own pipeline is a 404; a
 * built-in is a 400 with where its code is. The MCP tool `pipeline_get`
 * does the same, through the same function.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const res = await pipelinePackage(user.id, id);
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.missing ? 404 : 400 });
  }
  return NextResponse.json(res.pkg);
}
