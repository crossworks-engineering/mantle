/**
 * GET /api/apps/members: the members' apps an admin meets in the Apps
 * screen (workspace review pattern, 2026-10-09), in two lists. `waiting`:
 * submitted for approval (title, author, sent when, version), oldest first.
 * `shared`: shared with the team and not submitted (title, author, whether
 * the author is still an active member, last activity). Never a private
 * draft (rule S3). Replaces Team admin > App review and > Member apps.
 */
import { NextResponse } from '@/server/http-compat';
import { listMemberAppsForReview } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json(await listMemberAppsForReview());
}
