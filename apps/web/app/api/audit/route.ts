import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { queryAuditLog } from '@/lib/audit-query';

/**
 * GET /api/audit — the audit-log list for the client-fetch path (the split
 * client's /settings/audit screen). Same query, filters and pagination as the
 * SSR page (shared lib/audit-query.ts). Any logged-in admin may view it —
 * it's a trail, not a secret.
 */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const sp = new URL(req.url).searchParams;
  const result = await queryAuditLog({
    actor: sp.get('actor') ?? undefined,
    action: sp.get('action') ?? undefined,
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
    page: Number.parseInt(sp.get('page') ?? '1', 10) || 1,
  });
  return NextResponse.json(result);
}
