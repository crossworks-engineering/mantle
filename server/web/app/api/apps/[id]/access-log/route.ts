/**
 * GET /api/apps/[id]/access-log — recent EXTERNAL activity on a shared app.
 * Owner-scoped. Surfaces the app_access_log the /s/ brokers write: who (a team
 * member, or anonymous for public), what (auth/tool/db), and when.
 */
import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { listAppAccess } from '@mantle/content';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const entries = await listAppAccess(user.id, id, 100);
  return NextResponse.json({ entries });
}
