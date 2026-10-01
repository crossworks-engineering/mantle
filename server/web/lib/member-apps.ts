/**
 * Apps for members (member logins Phase 4b): the one lookup every member app
 * route makes. A member runs an app at team level or lower with a green
 * PUBLISHED build; everything else (an admin app, a draft-only app, another
 * brain's app, no such id) is the same plain 404.
 *
 * Two locks: the rule is written in the query (@mantle/content member-apps),
 * and the query runs on the team role, so row security holds as well.
 */
import { NextResponse } from '@/server/http-compat';
import { withViewer } from '@mantle/db';
import { getMemberRunnableApp, type MemberRunnableApp } from '@mantle/content';
import { isUuid } from '@mantle/std';
import type { MemberCaller } from '@/lib/auth';

/** The app, or a 404 response. */
export async function memberAppOr404(
  anchorId: string,
  id: string,
): Promise<MemberRunnableApp | NextResponse> {
  const notFound = NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  if (!isUuid(id)) return notFound;
  const app = await withViewer('team', () => getMemberRunnableApp(anchorId, id.toLowerCase()));
  return app ?? notFound;
}

/** Who a member is on the team surface and in the access log. */
export function memberName(member: MemberCaller): string {
  return member.displayName?.trim() || member.email.split('@')[0] || 'member';
}
