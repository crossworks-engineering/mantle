/**
 * GET /api/team-admin/shares — the Shared-links tab: every active share,
 * shaped exactly as SharedLinksPanel expects (the old SSR page's mapping),
 * no `level` (a link does not follow one). `retired` (the old client links)
 * is always []: the client portal is gone, and a retired link answers a
 * plain 410. The field stays so the wire shape does not change.
 */
import type { RetiredClientLinkRow, SharedLinkRow } from '@mantle/client-types';
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { listActiveShares } from '@mantle/content';
import { teamAdminBadges } from '@/lib/team-admin-overview';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'users' },
});

export async function GET() {
  const user = ownerCaller();
  const [badges, active] = await Promise.all([teamAdminBadges(user.id), listActiveShares(user.id)]);
  return NextResponse.json({
    badges,
    shares: active.map((s): SharedLinkRow => ({
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
      // A contact share (0214): the contact it is for, and its right.
      contactId: s.contactId,
      contactName: s.contactName,
      canWrite: s.canWrite,
    })),
    retired: [] as RetiredClientLinkRow[],
  });
}
