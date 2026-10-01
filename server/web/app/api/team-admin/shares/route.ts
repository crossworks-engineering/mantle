/**
 * GET /api/team-admin/shares — the Shared-links tab: every active share,
 * shaped exactly as SharedLinksPanel expects (the old SSR page's mapping),
 * with each item's `level` (SharedLinkRow.level; audit A18), and `retired`:
 * the old client links C3 retired (RetiredClientLinkRow; they answer "Sign
 * in as a client" now), so the admin sees which customer URLs stopped.
 */
import type { RetiredClientLinkRow, SharedLinkRow } from '@mantle/client-types';
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { listActiveShares, listRetiredClientLinks } from '@mantle/content';
import { teamAdminBadges } from '@/lib/team-admin-overview';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [badges, active, retired] = await Promise.all([
    teamAdminBadges(user.id),
    listActiveShares(user.id),
    listRetiredClientLinks(user.id),
  ]);
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
      level: s.level,
      // A contact share (0214): the contact it is for, and its right.
      contactId: s.contactId,
      contactName: s.contactName,
      canWrite: s.canWrite,
    })),
    retired: retired.map((r): RetiredClientLinkRow => ({
      id: r.id,
      nodeId: r.nodeId,
      nodeType: r.nodeType,
      title: r.title,
      icon: r.nodeIcon,
      level: r.level,
      createdAt: r.createdAt,
      retiredAt: r.retiredAt,
      viewCount: r.viewCount,
      lastViewedAt: r.lastViewedAt,
    })),
  });
}
