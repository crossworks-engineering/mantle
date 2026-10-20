/**
 * Apps for members (member logins Phase 4b): the one lookup every member app
 * run makes (lib/app-runner.ts). A member runs an app a workspace of theirs
 * holds, with a green PUBLISHED build; everything else (an app no workspace
 * of theirs holds, a draft-only app, another brain's app, no such id) is the
 * same plain 404.
 *
 * Two locks: the rule is written in the query (@mantle/content member-apps),
 * and the query runs in the login's own workspace scope, so row security
 * holds as well. Since W6b a member-built app is a brain item in its
 * author's private workspace (the personal space is folded into the brain),
 * so this one lookup finds it; the space-app lookup on the system pool went
 * with W7e.
 */
import { NextResponse } from '@/server/http-compat';
import { withViewer } from '@mantle/db';
import { getMemberRunnableApp, type MemberRunnableApp } from '@mantle/content';
import { isUuid } from '@mantle/std';
import type { MemberCaller } from '@/lib/auth';

/** An app a member may run, with the owner its rows are keyed to (the
 *  brain). */
export type MemberApp = MemberRunnableApp & { ownerId: string };

/** The app, or a 404 response. */
export async function memberAppOr404(
  anchorId: string,
  id: string,
  loginId: string,
): Promise<MemberApp | NextResponse> {
  const notFound = NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  if (!isUuid(id)) return notFound;
  const appId = id.toLowerCase();
  const app = await withViewer({ login: loginId }, () => getMemberRunnableApp(anchorId, appId));
  return app ? { ...app, ownerId: anchorId } : notFound;
}

/** Who a member is on the team surface and in the access log. */
export function memberName(member: Pick<MemberCaller, 'displayName' | 'email'>): string {
  return member.displayName?.trim() || member.email.split('@')[0] || 'member';
}
