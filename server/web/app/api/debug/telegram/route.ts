import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import {
  countTelegramChats,
  listAgentActivity,
  listTelegramChats,
  telegramChatVisibility,
} from '@/lib/debug';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { RouteSwitches } from '@/lib/auth/route-switches';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});
/** Served under the box policy's Telegram switch (MANTLE_POLICY_TELEGRAM=off,
 *  docs/policy.md): the gate answers 403 policy_telegram_off first while it is
 *  off (lib/auth/route-switches.ts). */
export const routeSwitches = { GET: 'telegram-policy' } as const satisfies RouteSwitches;

/** GET /api/debug/telegram?page=&q= — Telegram chats (paginated) plus the agent
 *  list for the per-chat responder override dropdown. Only the chats the
 *  caller may see: the anchor every chat, any other
 *  Admin user its own and those of the bots it moderates. */
const PAGE_SIZE = 50;

export async function GET(req: Request) {
  const user = ownerCaller();
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const query = url.searchParams.get('q')?.trim() || undefined;
  const visible = await telegramChatVisibility(user.id, user.actor.id);
  const [chats, total, agents] = await Promise.all([
    listTelegramChats(user.id, {
      query,
      visible,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countTelegramChats(user.id, { query, visible }),
    listAgentActivity(user.id),
  ]);
  return NextResponse.json({ chats, total, agents, page, pageSize: PAGE_SIZE });
}
