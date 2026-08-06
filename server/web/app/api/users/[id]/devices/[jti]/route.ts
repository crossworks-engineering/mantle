import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, mobileTokens, authUsers, and, eq } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';

const IdParams = z.object({ id: z.string().uuid(), jti: z.string().min(1) });

/**
 * DELETE /api/users/[id]/devices/[jti] — revoke one bearer device. The next
 * request from that device fails the mobile_tokens liveness check in
 * getBearerUser(). Scoped to the named login's rows; idempotent on ids that
 * are already revoked (they simply no longer match).
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; jti: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof NextResponse) return user;

  const parsed = IdParams.safeParse(await ctx.params);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const { id: targetId, jti } = parsed.data;

  const [target] = await db
    .select({ id: authUsers.id, email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, targetId))
    .limit(1);
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  const [row] = await db
    .select({ id: mobileTokens.id, label: mobileTokens.label })
    .from(mobileTokens)
    .where(and(eq(mobileTokens.id, jti), eq(mobileTokens.userId, targetId)))
    .limit(1);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  await db.update(mobileTokens).set({ revokedAt: new Date() }).where(eq(mobileTokens.id, jti));
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'auth.device_revoked',
    method: 'DELETE',
    path: `/api/users/${targetId}/devices/${jti}`,
    detail: { device: row.label, targetId, targetEmail: target.email },
    ...requestMetaFrom(req),
  });
  return NextResponse.json({ ok: true });
}
