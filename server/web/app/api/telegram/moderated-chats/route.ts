/**
 * GET /api/telegram/moderated-chats: the chats of every Telegram bot the
 * signed-in user moderates, `{ chats:
 * ModeratedTelegramChat[] }`: bots whose assistant's workspace they are a
 * Moderator of, or every bot for an Admin user with the users area. They
 * may block or unpair these (POST /api/telegram/chats/:id/block|unpair),
 * never pair them. Empty for anyone else, a client included.
 */
import { NextResponse } from '@/server/http-compat';
import { chatCaller } from '@/lib/auth';
import { listModeratedTelegramChats } from '@/lib/agent-telegram';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', open: 'telegram' },
});

export async function GET() {
  const login = chatCaller();
  const chats = await listModeratedTelegramChats(login.ownerId, login.loginId);
  return NextResponse.json({ chats });
}
