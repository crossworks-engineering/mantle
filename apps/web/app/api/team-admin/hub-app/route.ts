/**
 * Owner-only designation of the TEAM HUB APP — the mini-app the /team shell
 * renders full-bleed in place of the built-in hub (see @mantle/content/team-hub
 * `resolveTeamHubApp` for the chain that must hold at read time).
 *
 * PUT { appId } — designate: requires a green PUBLISHED build, then ensures the
 * app's active share exists and is TEAM-mode (members authenticate to
 * /s/<token>/* with the team cookie), then points the `teamHubAppId` pref at
 * it. Share creation happens HERE, at designation time — never as a side
 * effect of a member loading the hub.
 *
 * DELETE — undesignate: clears the pref only. The share is left alone (it may
 * be serving other purposes); revoking it stays a separate, deliberate act on
 * the app's own share controls.
 *
 * Session-gated — under /api/team-admin, which is NOT in PUBLIC_PATHS, so it
 * carries the owner session, never a team token.
 */
import { NextResponse } from 'next/server';
import {
  createShare,
  getApp,
  setShareMode,
  updateProfilePreferences,
} from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const appId = (body as { appId?: unknown }).appId;
  if (typeof appId !== 'string' || appId.length === 0) {
    return NextResponse.json({ error: 'appId is required' }, { status: 400 });
  }

  const app = await getApp(user.id, appId);
  if (!app) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  if (app.publishedBuild?.ok !== true) {
    return NextResponse.json(
      { error: 'the app has no published build — publish it before designating it as the hub' },
      { status: 409 },
    );
  }

  // Idempotent: returns the existing active share when there is one. If that
  // share was PUBLIC we flip it to team — the hub slot must never be reachable
  // without a member token. Surfaced in the response so the UI can say so.
  const share = await createShare(user.id, appId);
  const modeChanged = share.mode !== 'team';
  if (modeChanged) await setShareMode(user.id, share.id, 'team');

  await updateProfilePreferences(user.id, { teamHubAppId: appId });
  return NextResponse.json({ appId, shareToken: share.token, modeChanged });
}

export async function DELETE() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  // '' is the deliberate clear — projects to undefined on read.
  await updateProfilePreferences(user.id, { teamHubAppId: '' });
  return NextResponse.json({ cleared: true });
}
