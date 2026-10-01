import { NextResponse } from '@/server/http-compat';
import { db, authUsers, mobileTokens, eq } from '@mantle/db';
import { endLoginSessions, mobileTokenJti } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { deleteTokenSubscriptions, forgetRelayDevices } from '@/lib/push/store';

/**
 * Revoke the calling device's mobile token. Self-authenticates from the
 * Authorization: Bearer token (its `jti`), so it lives under the public
 * /api/auth prefix. Idempotent — always 200, so it can't be used to probe
 * whether a token is valid.
 *
 * The push devices that token enrolled go with it (0211): a signed-out phone
 * gets no more teasers. A CLIENT's sign-out ends every session of the login
 * (its other devices and its browser too), as its web sign-out does (client
 * logins audit B23).
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
    // Only a token that is still live signs out: a revoked or expired one
    // (a copy someone kept) must not end a client's other sessions.
    const [row] = await db
      .select({
        userId: mobileTokens.userId,
        label: mobileTokens.label,
        revokedAt: mobileTokens.revokedAt,
        expiresAt: mobileTokens.expiresAt,
        email: authUsers.email,
        role: authUsers.role,
      })
      .from(mobileTokens)
      .innerJoin(authUsers, eq(authUsers.id, mobileTokens.userId))
      .where(eq(mobileTokens.id, jti))
      .limit(1);
    if (row && !row.revokedAt && row.expiresAt.getTime() > Date.now()) {
      await db.update(mobileTokens).set({ revokedAt: new Date() }).where(eq(mobileTokens.id, jti));
      await forgetRelayDevices(await deleteTokenSubscriptions(jti));
      const everywhere = row.role === 'client';
      if (everywhere) await endLoginSessions(row.userId);
      // Attribute the logout via the token row (the signed jti proves possession).
      auditFireAndForget({
        actorId: row.userId,
        actorEmail: row.email,
        action: 'auth.logout',
        method: 'POST',
        path: '/api/auth/mobile-logout',
        detail: {
          channel: 'mobile',
          device: row.label,
          ...(everywhere ? { everywhere: true } : {}),
        },
        ...requestMetaFrom(req),
      });
    }
  }
  return NextResponse.json({ ok: true });
}
