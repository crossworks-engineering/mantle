/**
 * POST /api/telegram/chats/:id/block: block a Telegram chat (workspaces
 * W7d): its messages are dropped and it has no user, until a Moderator
 * unpairs it. By its own user, a Moderator of its bot's workspace, or an
 * Admin user with the users area. 404 for a chat the login may not touch.
 */
import { NextResponse } from '@/server/http-compat';
import { chatLoginCaller } from '@/lib/auth';
import { moderateTelegramChatResponse } from '@/lib/agent-telegram';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = chatLoginCaller();
  const { id } = await ctx.params;
  const r = await moderateTelegramChatResponse(login, id, 'block');
  return NextResponse.json(r.body, { status: r.status });
}
