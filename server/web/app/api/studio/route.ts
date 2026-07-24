import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { buildStudioGraph } from '@/lib/studio/graph';

/**
 * GET /api/studio — the Agent Studio graph: live agent/skill/tool-group/worker
 * rows + the config-integrity report, assembled the way a real turn composes
 * each prompt. Owner-scoped; recomputed per request (no cache).
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const graph = await buildStudioGraph(user.id);
  return NextResponse.json({ graph });
}
