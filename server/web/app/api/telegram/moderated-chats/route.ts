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
import type { RouteSwitches } from '@/lib/auth/route-switches';

export const policy = routePolicy({
  GET: { class: 'self', open: 'telegram' },
});
/** Served under the box policy's Telegram switch (MANTLE_POLICY_TELEGRAM=off,
 *  docs/policy.md): the gate answers 403 policy_telegram_off first while it is
 *  off (lib/auth/route-switches.ts). */
export const routeSwitches = { GET: 'telegram-policy' } as const satisfies RouteSwitches;

export async function GET() {
  const login = chatCaller();
  const chats = await listModeratedTelegramChats(login.ownerId, login.loginId);
  return NextResponse.json({ chats });
}
