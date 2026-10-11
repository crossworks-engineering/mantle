/**
 * GET /api/telegram/my-chats: the signed-in user's own paired Telegram chats
 * (workspaces W7d), `{ chats: MyTelegramChat[] }`. Any login; a client has
 * none.
 */
import { NextResponse } from '@/server/http-compat';
import { getChatLoginOr401 } from '@/lib/auth';
import { listMyTelegramChats } from '@/lib/agent-telegram';

export async function GET() {
  const login = await getChatLoginOr401();
  if (login instanceof NextResponse) return login;
  if (login.kind === 'client') return NextResponse.json({ chats: [] });
  const chats = await listMyTelegramChats(login.ownerId, login.loginId);
  return NextResponse.json({ chats });
}
