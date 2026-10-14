import { NextResponse } from '@/server/http-compat';
import { listActiveShares } from '@mantle/content';
import { ownerCaller } from '@/lib/auth';

/** GET /api/shares/all → every ACTIVE share the owner has, newest first — the
 *  "what is exposed right now" registry (every live link is public). No
 *  `level` since workspaces W5b2: a link does not follow a level. */
export async function GET() {
  const user = ownerCaller();
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
      // A contact share (0214): the contact it is for, and its right.
      contactId: s.contactId,
      contactName: s.contactName,
      canWrite: s.canWrite,
    })),
  });
}
