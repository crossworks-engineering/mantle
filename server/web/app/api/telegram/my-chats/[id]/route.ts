/**
 * DELETE /api/telegram/my-chats/:id: unpair one of the signed-in user's own
 * Telegram chats (workspaces W7d). The chat goes back to pending with no
 * user; the person pairs it again with a new code. 404 when the chat is not
 * one the login may touch.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getChatLoginOr401 } from '@/lib/auth';
import { unpairMyTelegramChat } from '@/lib/agent-telegram';

const IdParams = z.object({ id: z.string().uuid() });

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = await getChatLoginOr401();
  if (login instanceof NextResponse) return login;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  if (login.kind === 'client') return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  const ok = await unpairMyTelegramChat(login.ownerId, login.loginId, idParsed.data.id);
  if (!ok) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
