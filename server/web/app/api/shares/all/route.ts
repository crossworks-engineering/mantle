import { NextResponse } from 'next/server';
import { listActiveShares } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';

/** GET /api/shares/all → every ACTIVE share the owner has, newest first — the
 *  "what is exposed right now" registry (public and team links alike). */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const shares = await listActiveShares(user.id);
  return NextResponse.json({
    shares: shares.map((s) => ({
      id: s.id,
      path: `/s/${s.token}`,
      nodeId: s.nodeId,
      nodeType: s.nodeType,
      title: s.title,
      icon: s.nodeIcon,
      mode: s.mode,
      cascade: s.cascade,
      createdAt: s.createdAt,
      viewCount: s.viewCount,
      lastViewedAt: s.lastViewedAt,
    })),
  });
}
