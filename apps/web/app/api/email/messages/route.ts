import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listMessages } from '@mantle/email';
import { getOwnerOr401 } from '@/lib/auth';

const Query = z.object({
  account: z.string().uuid(),
  folder: z.string().optional(),
  unread: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Message list for one owned account (centre pane), newest first. */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const sp = new URL(req.url).searchParams;
  const parsed = Query.safeParse({
    account: sp.get('account') ?? undefined,
    folder: sp.get('folder') ?? undefined,
    unread: sp.get('unread') ?? undefined,
    limit: sp.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid query' },
      { status: 400 },
    );
  }
  const { account, folder, unread, limit } = parsed.data;
  const messages = await listMessages(user.id, { accountId: account, folder, unreadOnly: unread, limit });
  return NextResponse.json({ messages });
}
