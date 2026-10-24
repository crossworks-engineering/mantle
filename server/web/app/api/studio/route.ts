import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { buildStudioGraph } from '@/lib/studio/graph';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'assistants' },
});

/**
 * GET /api/studio — the Agent Studio graph: live agent/skill/tool-group/worker
 * rows + the config-integrity report, assembled the way a real turn composes
 * each prompt. Owner-scoped; recomputed per request (no cache).
 */

export async function GET() {
  const user = ownerCaller();
  const graph = await buildStudioGraph(user.id);
  return NextResponse.json({ graph });
}
