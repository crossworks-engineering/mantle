import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { loadNodeBiography } from '@/lib/node-biography';

/**
 * GET /api/nodes/[id]/history — the full node "biography": the node + every
 * trace + step that touched it. Owner-scoped; 404 (not 403) for a leaked id so
 * existence doesn't leak.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const view = await loadNodeBiography(user.id, id);
  if (!view) return NextResponse.json({ error: 'Node not found.' }, { status: 404 });
  return NextResponse.json({ view });
}
