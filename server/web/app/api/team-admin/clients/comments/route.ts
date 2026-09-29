/**
 * GET /api/team-admin/clients/comments?days=7 (client logins C5 audit, U2):
 * the client-level items whose client thread had a comment by a CLIENT in
 * the last `days` days (1 to 90, default 7), newest first, at most 100, so
 * an admin notices a client's question on a brain with no members. The
 * thread itself: /api/nodes/:id/comments. Admin only.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { clientThreadActivity } from '@mantle/content';
import type { ClientThreadActivity } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';

const Query = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const days = new URL(req.url).searchParams.get('days');
  const parsed = Query.safeParse(days === null ? {} : { days });
  if (!parsed.success) {
    return NextResponse.json({ error: '`days` must be 1 to 90.' }, { status: 400 });
  }
  const body: ClientThreadActivity = {
    rows: await clientThreadActivity(user.id, parsed.data.days),
  };
  return NextResponse.json(body);
}
