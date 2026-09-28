import { NextResponse } from '@/server/http-compat';
import { listActiveShares } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';

/** GET /api/shares/all → every ACTIVE share the owner has, newest first — the
 *  "what is exposed right now" registry (every live link is public). `level`
 *  is the item's level (client logins C1): a live link on a client item is
 *  an old one, made when client meant an open link. */
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
      level: s.level,
    })),
  });
}
