import { NextResponse } from '@/server/http-compat';
import { db, authUsers, mobileTokens, eq } from '@mantle/db';
import { mobileTokenJti } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';

/**
 * Revoke the calling device's mobile token. Self-authenticates from the
 * Authorization: Bearer token (its `jti`), so it lives under the public
 * /api/auth prefix. Idempotent — always 200, so it can't be used to probe
 * whether a token is valid.
 */
function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

export async function POST(req: Request) {
  const token = bearer(req);
  const jti = token ? mobileTokenJti(token) : null;
  if (jti) {
    await db.update(mobileTokens).set({ revokedAt: new Date() }).where(eq(mobileTokens.id, jti));
    // Attribute the logout via the token row (the signed jti proves possession).
    const [row] = await db
      .select({ userId: mobileTokens.userId, label: mobileTokens.label, email: authUsers.email })
      .from(mobileTokens)
      .innerJoin(authUsers, eq(authUsers.id, mobileTokens.userId))
      .where(eq(mobileTokens.id, jti))
      .limit(1);
    if (row) {
      auditFireAndForget({
        actorId: row.userId,
        actorEmail: row.email,
        action: 'auth.logout',
        method: 'POST',
        path: '/api/auth/mobile-logout',
        detail: { channel: 'mobile', device: row.label },
        ...requestMetaFrom(req),
      });
    }
  }
  return NextResponse.json({ ok: true });
}
