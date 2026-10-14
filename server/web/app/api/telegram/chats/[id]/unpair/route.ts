/**
 * POST /api/telegram/chats/:id/unpair: unpair a Telegram chat (workspaces
 * W7d): back to pending with no user, so the person pairs it again with a
 * new code. By its own user, a Moderator of its bot's workspace, or an
 * Admin user with the users area. 404 for a chat the login may not touch.
 */
import { NextResponse } from '@/server/http-compat';
import { chatLoginCaller } from '@/lib/auth';
import { moderateTelegramChatResponse } from '@/lib/agent-telegram';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = chatLoginCaller();
  const { id } = await ctx.params;
  const r = await moderateTelegramChatResponse(login, id, 'unpair');
  return NextResponse.json(r.body, { status: r.status });
}
