/**
 * GET /api/team-admin/shares — the Shared-links tab: every active share,
 * shaped exactly as SharedLinksPanel expects (the old SSR page's mapping).
 */
import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { listActiveShares } from '@mantle/content';
import { teamAdminBadges } from '@/lib/team-admin-overview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [badges, active] = await Promise.all([teamAdminBadges(user.id), listActiveShares(user.id)]);
  return NextResponse.json({
    badges,
    shares: active.map((s) => ({
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
