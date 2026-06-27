import { NextResponse } from 'next/server';
import { z } from 'zod';
import { recentUnknownSenders } from '@mantle/email';
import { getOwnerOr401 } from '@/lib/auth';

const Query = z.object({
  sinceDays: z.coerce.number().int().min(1).max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Live-discover senders who recently emailed the owner but aren't yet contacts.
 *  Reads IMAP on demand across enabled accounts; persists nothing. */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const sp = new URL(req.url).searchParams;
  const parsed = Query.safeParse({
    sinceDays: sp.get('sinceDays') ?? undefined,
    limit: sp.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  }
  const result = await recentUnknownSenders(user.id, parsed.data);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
