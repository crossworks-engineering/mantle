import { NextResponse } from '@/server/http-compat';
import { listDeletedSpaceApps } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';

/**
 * GET /api/member/my-apps/deleted: the member's own trash, newest delete
 * first (access matrix N6; the my_app_deleted_list tool's twin). It holds
 * at most MY_APPS_TRASH_MAX apps, and nothing in it expires.
 */
export async function GET() {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const apps = await listDeletedSpaceApps({ loginId: member.loginId, spaceId: member.spaceId });
  return NextResponse.json({ apps });
}
