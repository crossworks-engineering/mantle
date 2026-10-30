/**
 * GET /api/telegram/my-chats: the signed-in user's own paired Telegram chats
 * `{ chats: MyTelegramChat[] }`. Any login; a client has
 * none.
 */
import { NextResponse } from '@/server/http-compat';
import { chatCaller } from '@/lib/auth';
import { listMyTelegramChats } from '@/lib/agent-telegram';
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
  const chats = await listMyTelegramChats(login.ownerId, login.loginId);
  return NextResponse.json({ chats });
}
