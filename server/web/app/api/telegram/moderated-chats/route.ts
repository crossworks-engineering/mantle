/**
 * GET /api/telegram/moderated-chats: the chats of every Telegram bot the
 * signed-in user moderates (workspaces W7d), `{ chats:
 * ModeratedTelegramChat[] }`: bots whose assistant's workspace they are a
 * Moderator of, or every bot for an Admin user with the users area. They
 * may block or unpair these (POST /api/telegram/chats/:id/block|unpair),
 * never pair them. Empty for anyone else, a client included.
 */
import { NextResponse } from '@/server/http-compat';
import { chatLoginCaller } from '@/lib/auth';
import { listModeratedTelegramChats } from '@/lib/agent-telegram';

export async function GET() {
  const login = chatLoginCaller();
  const chats = await listModeratedTelegramChats(login.ownerId, login.loginId);
  return NextResponse.json({ chats });
}
