/**
 * Owner-only backing API for the Team admin surface's settings. GET returns
 * the Settings tab's data: the read posture and `teamAssistant`, the Team
 * workspace's assistant
 * that members chat with (workspaces W5c; null: no member chat, set one on
 * the Team workspace's page). No agent level is read. PATCH flips the
 * `teamPrivateReads` switch (whether the Team assistant may read the
 * owner's email and journal on a member's behalf). The member home app
 * designation left with per-workspace landing pages (task d78e7bde): each
 * workspace sets its home app on its own screen.
 * Session/bearer-gated: `/api/team-admin` is not in PUBLIC_PATHS.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import {
  updateProfilePreferences,
  loadProfilePreferences,
  isTeamPrivateReadsEnabled,
  teamAssistant,
} from '@mantle/content';
import { teamAdminBadges } from '@/lib/team-admin-overview';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [badges, prefs, assistant] = await Promise.all([
    teamAdminBadges(user.id),
    loadProfilePreferences(user.id),
    // Who a member chats with: the Team workspace's assistant, in the
    // member's own thread (/api/member/chat answers 410 since W7c).
    teamAssistant(user.id),
  ]);
  return NextResponse.json({
    badges,
    privateReads: isTeamPrivateReadsEnabled(prefs),
    teamAssistant: assistant
      ? { slug: assistant.slug, name: assistant.name, workspaceId: assistant.workspaceId }
      : null,
  });
}

export async function PATCH(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const teamPrivateReads = (body as { teamPrivateReads?: unknown }).teamPrivateReads;
  if (typeof teamPrivateReads !== 'boolean') {
    return NextResponse.json({ error: 'teamPrivateReads must be a boolean' }, { status: 400 });
  }
  await updateProfilePreferences(user.id, { teamPrivateReads });
  return NextResponse.json({ teamPrivateReads });
}
