/**
 * GET /api/telegram/my-chats: the signed-in user's own paired Telegram chats
 * (workspaces W7d), `{ chats: MyTelegramChat[] }`. Any login; a client has
 * none.
 */
import { NextResponse } from '@/server/http-compat';
import { chatLoginCaller } from '@/lib/auth';
import { listMyTelegramChats } from '@/lib/agent-telegram';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', open: 'telegram' },
});

export async function GET() {
  const login = chatLoginCaller();
  const chats = await listMyTelegramChats(login.ownerId, login.loginId);
  return NextResponse.json({ chats });
}
