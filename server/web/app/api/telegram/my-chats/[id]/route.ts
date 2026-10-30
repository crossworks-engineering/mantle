/**
 * DELETE /api/telegram/my-chats/:id: unpair one of the signed-in user's own
 * Telegram chats. The chat goes back to pending with no
 * user; the person pairs it again with a new code. 404 when the chat is not
 * one the login may touch.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { chatCaller } from '@/lib/auth';
import { unpairMyTelegramChat } from '@/lib/agent-telegram';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { RouteSwitches } from '@/lib/auth/route-switches';

export const policy = routePolicy({
  DELETE: {
    class: 'self',
    open: 'telegram',
    item: {
      none: "a Telegram chat pairing of the login's own, no workspace item: the handler acts only on its own",
    },
  },
});
/** Served under the box policy's Telegram switch (MANTLE_POLICY_TELEGRAM=off,
 *  docs/policy.md): the gate answers 403 policy_telegram_off first while it is
 *  off (lib/auth/route-switches.ts). */
export const routeSwitches = { DELETE: 'telegram-policy' } as const satisfies RouteSwitches;

const IdParams = z.object({ id: z.string().uuid() });

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = chatCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const ok = await unpairMyTelegramChat(login.ownerId, login.loginId, idParsed.data.id);
  if (!ok) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
