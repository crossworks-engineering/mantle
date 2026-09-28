/**
 * GET /api/team-admin/member-chats?login=<id>&before=<iso>&portalBefore=<iso>
 * is the owner's view of member chats. Users are the team: a member LOGIN
 * chats with the team agent (/api/member/chat), one thread per login in
 * team_messages. This lists every member login with its thread's last message
 * and size, plus a window of the selected login's thread (newest first by
 * default; `before` pages older).
 *
 * A login invited from a team contact also gets `portalThread`: a window of
 * that contact's OLD team portal chat (`portalBefore` pages older), kept
 * apart from `thread`. It is history for the admin only: the member's own
 * GET /api/member/chat and the turn's context never read it.
 *
 * Read-only. Both windows are admin reads: a reply marked used_private shows
 * the placeholder. The Members tab (GET /api/team-admin/members) still shows
 * the portal threads of team-code holders as history.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { listLoginPortalThread, listMemberChatActivity, listTeamThread } from '@mantle/content';
import type { TeamMessage } from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import type { MemberChatArchiveMessage, MemberChatsResponse } from '@mantle/client-types';

const THREAD_WINDOW = 50;

function toArchive(m: TeamMessage): MemberChatArchiveMessage {
  return {
    id: m.id,
    direction: m.direction as 'inbound' | 'outbound',
    text: m.text,
    status: m.status,
    error: m.error,
    traceId: m.traceId,
    createdAt: m.createdAt.toISOString(),
  };
}

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const login = url.searchParams.get('login') ?? undefined;
  const before = url.searchParams.get('before') ?? undefined;
  const portalBefore = url.searchParams.get('portalBefore') ?? undefined;

  const members = await listMemberChatActivity(user.id);
  const selectedId =
    login && UUID_RE.test(login) && members.some((m) => m.loginId === login)
      ? login
      : (members[0]?.loginId ?? null);
  if (!selectedId) {
    return NextResponse.json({ members, selected: null } satisfies MemberChatsResponse);
  }

  const [thread, portal] = await Promise.all([
    listTeamThread(user.id, '', {
      loginId: selectedId,
      limit: THREAD_WINDOW,
      ...(before ? { before } : {}),
    }),
    listLoginPortalThread(user.id, selectedId, {
      limit: THREAD_WINDOW,
      ...(portalBefore ? { before: portalBefore } : {}),
    }),
  ]);

  // No portal section for a login with no contact, or a contact that never
  // chatted on the portal (an empty OLDER page still answers, so the client
  // knows it reached the start).
  const portalThread =
    portal && (portal.messages.length > 0 || portalBefore)
      ? {
          contactId: portal.contactId,
          thread: portal.messages.map(toArchive),
          windowSize: THREAD_WINDOW,
        }
      : null;

  return NextResponse.json({
    members,
    selected: {
      loginId: selectedId,
      thread: thread.map(toArchive),
      windowSize: THREAD_WINDOW,
      portalThread,
    },
  } satisfies MemberChatsResponse);
}
