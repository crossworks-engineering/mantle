import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { listMessages } from '@mantle/email';
import { ownerCaller } from '@/lib/auth';
import { firstIssue } from '@/lib/zod-issue';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'connectors' },
});

const Query = z.object({
  account: z.string().uuid(),
  folder: z.string().optional(),
  unread: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Message list for one owned account (centre pane), newest first. */
export async function GET(req: Request) {
  const user = ownerCaller();
  const sp = new URL(req.url).searchParams;
  const parsed = Query.safeParse({
    account: sp.get('account') ?? undefined,
    folder: sp.get('folder') ?? undefined,
    unread: sp.get('unread') ?? undefined,
    limit: sp.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error, 'invalid query') }, { status: 400 });
  }
  const { account, folder, unread, limit } = parsed.data;
  const messages = await listMessages(user.id, {
    accountId: account,
    folder,
    unreadOnly: unread,
    limit,
  });
  return NextResponse.json({ messages });
}
