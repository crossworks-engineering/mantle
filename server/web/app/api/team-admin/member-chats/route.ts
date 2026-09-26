/**
 * GET /api/team-admin/member-chats?login=<id>&before=<iso> — the owner's view
 * of member chats. Users are the team: a member LOGIN chats with the team
 * agent (/api/member/chat), one thread per login in team_messages. This lists
 * every member login with its thread's last message and size, plus a window
 * of the selected login's thread (newest first by default; `before` pages
 * older).
 *
 * Read-only. The retired team-code portal threads are not here: the Members
 * tab (GET /api/team-admin/members) still shows them as history.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { listMemberChatActivity, listTeamThread } from '@mantle/content';
import { UUID_RE } from '@mantle/std';

const THREAD_WINDOW = 50;

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const login = url.searchParams.get('login') ?? undefined;
  const before = url.searchParams.get('before') ?? undefined;

  const members = await listMemberChatActivity(user.id);
  const selectedId =
    login && UUID_RE.test(login) && members.some((m) => m.loginId === login)
      ? login
      : (members[0]?.loginId ?? null);
  if (!selectedId) return NextResponse.json({ members, selected: null });

  const thread = await listTeamThread(user.id, '', {
    loginId: selectedId,
    limit: THREAD_WINDOW,
    ...(before ? { before } : {}),
  });

  return NextResponse.json({
    members,
    selected: {
      loginId: selectedId,
      thread: thread.map((m) => ({
        id: m.id,
        direction: m.direction,
        text: m.text,
        status: m.status,
        error: m.error,
        traceId: m.traceId,
        createdAt: m.createdAt.toISOString(),
      })),
      windowSize: THREAD_WINDOW,
    },
  });
}
