/**
 * DELETE /api/access-keys/:id : revoke one inbound API key (plan page
 * 1e62e204). Owner or admin only. The key stops on its next request. The
 * row stays (revoked) so the list and the audit trail still name it.
 */
import { NextResponse } from '@/server/http-compat';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { accessKeys, db } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMeta } from '@/lib/audit';

const Params = z.object({ id: z.string().uuid() });

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const [row] = await db
    .update(accessKeys)
    .set({ revokedAt: new Date(), revokedBy: user.actor.id })
    .where(and(eq(accessKeys.id, params.data.id), isNull(accessKeys.revokedAt)))
    .returning({ id: accessKeys.id, keyPrefix: accessKeys.keyPrefix, name: accessKeys.name });
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'key.revoked',
    method: 'DELETE',
    path: `/api/access-keys/${row.id}`,
    ...(await requestMeta()),
    detail: { keyId: row.id, keyPrefix: `mtlk_${row.keyPrefix}`, name: row.name },
  });
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
