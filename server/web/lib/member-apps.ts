/**
 * Apps for members (member logins Phase 4b): the one lookup every member app
 * route makes. A member runs an app at team level or lower with a green
 * PUBLISHED build, or (team apps Phase 3) a member-built app of their own or
 * one a teammate shared with the team; everything else (an admin app, a
 * draft-only app, a teammate's private app, another brain's app, no such id)
 * is the same plain 404.
 *
 * Two locks for a brain app: the rule is written in the query (@mantle/content
 * member-apps), and the query runs on the team role, so row security holds
 * as well. A member-built app lives in its author's personal space, which the
 * team role cannot read: its rule is written in the query
 * (`getRunnableSpaceApp`: the author, or shared with the team), on the admin
 * pool.
 */
import { NextResponse } from '@/server/http-compat';
import { withViewer } from '@mantle/db';
import { getMemberRunnableApp, getRunnableSpaceApp, type MemberRunnableApp } from '@mantle/content';
import { isUuid } from '@mantle/std';
import type { MemberCaller } from '@/lib/auth';

/** An app a member may run, with the owner its rows are keyed to: the brain
 *  for a brain app, the author's personal space for a member-built one. */
export type MemberApp = MemberRunnableApp & {
  ownerId: string;
  /** A member-built app, not yet accepted into the brain. */
  spaceApp: boolean;
};

/** The app, or a 404 response. A member-built app runs at team level (team
 *  rules, the author ceiling); under review its data is read only. */
export async function memberAppOr404(
  anchorId: string,
  id: string,
  loginId: string,
): Promise<MemberApp | NextResponse> {
  const notFound = NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  if (!isUuid(id)) return notFound;
  const appId = id.toLowerCase();
  const app = await withViewer('team', () => getMemberRunnableApp(anchorId, appId));
  if (app) return { ...app, ownerId: anchorId, spaceApp: false };
  const own = await getRunnableSpaceApp(loginId, appId);
  if (!own) return notFound;
  return {
    id: own.id,
    title: own.title,
    icon: own.icon,
    color: own.color,
    audience: 'team',
    manifest: own.manifest,
    publishedBuild: own.publishedBuild,
    dataReadOnly: own.dataReadOnly,
    ownerId: own.ownerId,
    spaceApp: true,
  };
}

/** Who a member is on the team surface and in the access log. */
export function memberName(member: MemberCaller): string {
  return member.displayName?.trim() || member.email.split('@')[0] || 'member';
}
