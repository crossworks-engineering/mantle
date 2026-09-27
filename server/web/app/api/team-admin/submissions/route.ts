/**
 * GET /api/team-admin/submissions : what waits for an admin (member logins
 * Phase 4, plan 6): items members submitted for review, oldest first, then
 * the team-shared items deactivated logins left behind. Never a private item
 * (S3): the queue query names both conditions.
 */
import { NextResponse } from '@/server/http-compat';
import { listReviewQueue } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json(await listReviewQueue());
}
