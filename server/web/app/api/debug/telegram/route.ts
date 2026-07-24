import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { countTelegramChats, listAgentActivity, listTelegramChats } from '@/lib/debug';

/** GET /api/debug/telegram?page=&q= — Telegram chats (paginated) plus the agent
 *  list for the per-chat responder override dropdown. */
const PAGE_SIZE = 50;

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const query = url.searchParams.get('q')?.trim() || undefined;
  const [chats, total, agents] = await Promise.all([
    listTelegramChats(user.id, { query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countTelegramChats(user.id, { query }),
    listAgentActivity(user.id),
  ]);
  return NextResponse.json({ chats, total, agents, page, pageSize: PAGE_SIZE });
}
