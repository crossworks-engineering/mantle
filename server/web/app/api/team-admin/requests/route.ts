/**
 * GET /api/team-admin/requests — the Requests tab: every change request (open
 * + done) and the pending forum-upload review queue.
 *
 * Runs `reconcileForumQuarantine` inline first — a deliberate exception to
 * "GETs don't write": it is idempotent self-repair whose whole purpose is
 * that the list you're about to read is consistent (covers brains whose
 * members stopped uploading, where the upload route's reconcile never
 * fires). Splitting it into a client-fired POST would reintroduce the
 * stale-first-render race the SSR page never had.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { listTeamRequests, listPendingForumUploads } from '@mantle/content';
import { reconcileForumQuarantine } from '@/lib/forum-quarantine';
import { teamAdminBadges } from '@/lib/team-admin-overview';


const UPLOADS_SHOWN = 100;

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  await reconcileForumQuarantine(user.id).catch((err) =>
    console.warn('[team-admin] quarantine reconcile failed:', err),
  );

  const [badges, requests, uploads] = await Promise.all([
    teamAdminBadges(user.id),
    listTeamRequests(user.id, { status: 'all', limit: 200 }),
    listPendingForumUploads(user.id, { limit: UPLOADS_SHOWN }),
  ]);
  const moreUploads = Math.max(0, badges.pendingUploadCount - uploads.length);

  return NextResponse.json({ badges, requests, uploads, moreUploads });
}
