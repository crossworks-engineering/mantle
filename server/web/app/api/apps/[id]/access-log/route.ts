/**
 * GET /api/apps/[id]/access-log — recent activity on an app. Owner-scoped.
 * Surfaces the app_access_log the brokers write: who (a member, a client, a
 * contact, or anonymous for public), what (auth/tool/db), and when; and the
 * errors the brokers answered the running app with, whoever ran it (kind
 * 'error', apps first-class plan G4). `?kind=error` (or auth/tool/db) lists
 * one kind; `?limit=` up to 500.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { listAppAccess, type AppAccessKind } from '@mantle/content';

const KINDS: readonly AppAccessKind[] = ['auth', 'tool', 'db', 'error'];

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const kind = KINDS.find((k) => k === q.get('kind'));
  const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 500);
  const entries = await listAppAccess(user.id, id, limit, kind ? { kind } : {});
  return NextResponse.json({ entries });
}
