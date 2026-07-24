import { NextResponse } from 'next/server';
import { db, mobileTokens, and, eq } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';

/**
 * DELETE /api/auth/devices/[jti] — revoke one bearer device. The next request
 * from that device fails the mobile_tokens liveness check in getBearerUser().
 * Scoped to the caller's own rows; idempotent on already-revoked ids.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ jti: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { jti } = await ctx.params;

  const [row] = await db
    .select({ id: mobileTokens.id, label: mobileTokens.label })
    .from(mobileTokens)
    .where(and(eq(mobileTokens.id, jti), eq(mobileTokens.userId, user.id)))
    .limit(1);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  await db.update(mobileTokens).set({ revokedAt: new Date() }).where(eq(mobileTokens.id, jti));
  auditFireAndForget({
    actorId: user.id,
    actorEmail: user.email,
    action: 'auth.device_revoked',
    method: 'DELETE',
    path: `/api/auth/devices/${jti}`,
    detail: { device: row.label },
    ...requestMetaFrom(req),
  });
  return NextResponse.json({ ok: true });
}
