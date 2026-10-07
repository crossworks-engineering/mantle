import { NextResponse } from '@/server/http-compat';
import { markLoginChatRead } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import { parseReadBody } from '@/lib/login-chat-read';
import { readJsonNoNul } from '@/lib/strip-nul';

/**
 * POST /api/member/chat/read { at? } -> { unread, lastReadAt }: mark this
 * login's own thread read up to `at` (an ISO time; the future counts as now)
 * or up to now (mobile_roles_push). The cursor never moves backwards. Its own thread
 * only, by the session's login.
 */
export async function POST(req: Request) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const body = parseReadBody(await readJsonNoNul(req));
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  return NextResponse.json(await markLoginChatRead(member.anchorId, member.loginId, body.at));
}
