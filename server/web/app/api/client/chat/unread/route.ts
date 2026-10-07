import { NextResponse } from '@/server/http-compat';
import { loginChatUnread } from '@mantle/content';
import { getClientOr401 } from '@/lib/auth';

/**
 * GET /api/client/chat/unread -> { unread, lastReadAt }: how many finished
 * replies in this login's own thread are newer than its read cursor (mobile_roles_push;
 * the phone app's badge). A login starts with nothing unread: the first call
 * sets the cursor to now. Its own thread only, by the session's login.
 */
export async function GET() {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  return NextResponse.json(await loginChatUnread(client.anchorId, client.loginId));
}
