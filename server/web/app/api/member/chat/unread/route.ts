import { NextResponse } from '@/server/http-compat';
import { loginChatUnread } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';

/**
 * GET /api/member/chat/unread -> { unread, lastReadAt }: how many finished
 * replies in this login's own thread are newer than its read cursor (0211;
 * the phone app's badge). A login starts with nothing unread: the first call
 * sets the cursor to now. Its own thread only, by the session's login.
 */
export async function GET() {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  return NextResponse.json(await loginChatUnread(member.anchorId, member.loginId));
}
