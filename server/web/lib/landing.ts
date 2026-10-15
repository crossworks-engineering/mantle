/**
 * A workspace's landing page (task d78e7bde; workspaces arch plan v2,
 * section 21): what a login sees at the root of the app while a workspace
 * is its current pick. GET /api/home?ws=<id> answers it for every login;
 * GET /api/member/home answers the Team workspace's for an older app.
 *
 * The landing page is the Built-in home, showing that workspace's data,
 * unless the workspace names a home app (workspaces.landing_app_id, set on
 * the workspace screen by a Moderator, lib/workspaces.ts). Without a
 * workspace it is "All my workspaces": the Built-in home over every
 * workspace of the login, never a home app.
 *
 * Every read runs in the login's scope (withViewer: the row rules show what
 * its workspaces hold), and a named workspace narrows it further to what
 * that workspace reads (nodeReadByWorkspace). The client keeps the pick; the
 * brain holds none. The site name is the brain's brand, the anchor's
 * preference: every login's scope reads the brain's profile row (the
 * own-login rule, 0266), as GET /api/shell answers the same site name to
 * every login.
 */
import { withViewer } from '@mantle/db';
import {
  libraryCounts,
  listLibrary,
  listMemberApps,
  loadProfilePreferences,
  resolveMemberHomeApp,
  firstSharedWorkspaceId,
  workspaceLandingAppId,
} from '@mantle/content';
import { APP_VERSION } from '@mantle/client-types/version';
import type { WorkspaceHomeData } from '@mantle/client-types';
import type { HubData } from '@mantle/share-ui/app-bridge-protocol';

/** How many pages the landing page gets as its sections. */
const SECTION_LIMIT = 30;

/** Who asks: the brain (anchor) and the login at the keyboard. */
export type LandingCaller = {
  anchorId: string;
  loginId: string;
  /** Display grade only: the hub's `memberName`. */
  name: string;
};

/** A login's display name for the hub: its name, else the part of its
 *  email before the @. */
export function landingName(who: { displayName: string | null; email: string }): string {
  return who.displayName?.trim() || who.email.split('@')[0] || 'member';
}

/**
 * The landing page of `ws` (a checked id, parseWsFilter) for `who`, or of
 * all its workspaces when `ws` is null. The data is read in the login's
 * scope; the home app only while `ws` holds it, its build is green and the
 * login may run it.
 */
export async function workspaceHome(
  who: LandingCaller,
  ws: string | null,
): Promise<WorkspaceHomeData<HubData>> {
  const prefs = await loadProfilePreferences(who.anchorId);
  return withViewer({ login: who.loginId }, async () => {
    const appId = ws ? await workspaceLandingAppId(who.anchorId, ws) : null;
    const [homeApp, pages, counts, apps] = await Promise.all([
      ws && appId ? resolveMemberHomeApp(who.anchorId, appId, ws) : Promise.resolve(null),
      listLibrary(who.anchorId, { kind: 'page', limit: SECTION_LIMIT, ws }),
      libraryCounts(who.anchorId, { ws }),
      listMemberApps(who.anchorId, { ws }),
    ]);
    return {
      ws,
      homeApp,
      hub: {
        siteName: prefs.siteName ?? null,
        memberName: who.name,
        version: APP_VERSION,
        sections: pages.items.map((p) => ({
          token: p.id,
          title: p.title,
          icon: p.icon,
          summary: p.summary,
          updatedAt: p.updatedAt,
          parentToken: null,
        })),
        counts,
        apps: apps
          .filter((a) => a.id !== homeApp?.appId)
          .map((a) => ({
            token: a.id,
            title: a.title,
            description: a.description,
            updatedAt: a.updatedAt,
          })),
      },
    };
  });
}

/** The login's first shared workspace as its scope reads it (null: none).
 *  For GET /api/member/home, whose app asks for no workspace: its one home
 *  app was the Team's, the oldest shared workspace of a brain switched
 *  before 0286 (firstSharedWorkspaceId). */
export async function firstSharedWorkspaceOf(who: LandingCaller): Promise<string | null> {
  return withViewer({ login: who.loginId }, () => firstSharedWorkspaceId(who.anchorId));
}
