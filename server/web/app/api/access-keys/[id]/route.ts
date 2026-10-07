/**
 * DELETE /api/access-keys/:id : revoke one inbound API key (plan page
 * 1e62e204). Every login, any role. The key stops on its next request. The
 * row stays (revoked) so the list and the audit trail still name it.
 *
 * A member or client revokes only their own keys (another key is a 404, as
 * if it did not exist). Any admin may revoke any key, another admin's own
 * key included (audit item 4, decided): revoke is the safe direction, and a
 * leaked key must be stoppable by whoever sees it first. Making a key is
 * the guarded step: a key acts only as the login that made it.
 */
import { NextResponse } from '@/server/http-compat';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { accessKeys, db } from '@mantle/db';
import { getLoginOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMeta } from '@/lib/audit';

const Params = z.object({ id: z.string().uuid() });

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = await getLoginOr401();
  if (login instanceof Response) return login;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const [row] = await db
    .update(accessKeys)
    .set({ revokedAt: new Date(), revokedBy: login.loginId })
    .where(
      and(
        eq(accessKeys.id, params.data.id),
        isNull(accessKeys.revokedAt),
        ...(login.kind === 'admin' ? [] : [eq(accessKeys.loginId, login.loginId)]),
      ),
    )
    .returning({
      id: accessKeys.id,
      keyPrefix: accessKeys.keyPrefix,
      name: accessKeys.name,
      loginId: accessKeys.loginId,
    });
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  auditFireAndForget({
    actorId: login.loginId,
    actorEmail: login.email,
    action: 'key.revoked',
    method: 'DELETE',
    path: `/api/access-keys/${row.id}`,
    ...(await requestMeta()),
    detail: {
      keyId: row.id,
      keyPrefix: `mtlk_${row.keyPrefix}`,
      name: row.name,
      loginId: row.loginId,
    },
  });
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
