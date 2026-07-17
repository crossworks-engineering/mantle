/**
 * GET /api/team/list?type=note|page|table|app|task|event|branch — the
 * team-visible shares of one type, newest first: ALL active shares (team and
 * public mode alike — a member may open both). This is the card list behind
 * each /team workspace section; opening a card renders /s/<token>, so the
 * share surface (and its per-request gating) stays the only content door.
 *
 * Same trust model as the rest of /api/team: self-authenticated via
 * resolveTeamChatCaller, membership liveness re-checked on every call.
 */
import { NextResponse } from 'next/server';
import {
  TEAM_WORKSPACE_TYPES,
  listTeamVisibleShares,
  type TeamWorkspaceType,
} from '@mantle/content';
import { resolveTeamChatCaller } from '@/lib/team-chat-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const type = new URL(req.url).searchParams.get('type') ?? '';
  if (!(TEAM_WORKSPACE_TYPES as readonly string[]).includes(type)) {
    return NextResponse.json({ error: 'invalid type' }, { status: 400 });
  }

  const items = await listTeamVisibleShares(caller.ownerId, type as TeamWorkspaceType);
  return NextResponse.json({ items });
}
