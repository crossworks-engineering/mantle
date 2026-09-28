/**
 * POST /api/access/client-report/ack { itemIds } -> the acknowledgement
 * (client logins C1). `itemIds`: the client-level items the admin was shown
 * on the report; only those still at client level are recorded. Adding a
 * client login stays disabled until the newest acknowledgement covers every
 * client-level item (C2). Owner only; audited by the owner gate.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { acknowledgeClientReport } from '@mantle/content';
import { firstIssue } from '@/lib/zod-issue';

const Body = z.object({ itemIds: z.array(z.string().uuid()).max(10_000) });

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error, 'itemIds required.') }, { status: 400 });
  }
  return NextResponse.json(
    await acknowledgeClientReport(user.id, user.actor.id, parsed.data.itemIds),
  );
}
