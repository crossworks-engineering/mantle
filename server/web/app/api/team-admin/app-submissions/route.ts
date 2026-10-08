/**
 * GET /api/team-admin/app-submissions: the apps members submitted for review
 * (team apps Phase 3), oldest first, with the tools each declares. Never a
 * private or team-shared app that was not submitted (rule S3).
 */
import { NextResponse } from '@/server/http-compat';
import { listSpaceAppSubmissions } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json({ submissions: await listSpaceAppSubmissions() });
}
