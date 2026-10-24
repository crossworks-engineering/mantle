/**
 * DELETE /api/telegram/my-chats/:id: unpair one of the signed-in user's own
 * Telegram chats (workspaces W7d). The chat goes back to pending with no
 * user; the person pairs it again with a new code. 404 when the chat is not
 * one the login may touch.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { chatLoginCaller } from '@/lib/auth';
import { unpairMyTelegramChat } from '@/lib/agent-telegram';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  DELETE: {
    class: 'self',
    open: 'telegram',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

const IdParams = z.object({ id: z.string().uuid() });

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = chatLoginCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const ok = await unpairMyTelegramChat(login.ownerId, login.loginId, idParsed.data.id);
  if (!ok) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
