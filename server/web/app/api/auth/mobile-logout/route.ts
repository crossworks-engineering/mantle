import { NextResponse } from '@/server/http-compat';
import { db, authUsers, mobileTokens, eq } from '@mantle/db';
import { endLoginSessions, verifyMobileToken } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import {
  deleteLegacySubscriptions,
  deleteTokenSubscriptions,
  forgetRelayDevices,
} from '@/lib/push/store';

/**
 * Revoke the calling device's mobile token. Self-authenticates from the
 * Authorization: Bearer token (its `jti`), so it lives under the public
 * /api/auth prefix. Idempotent — always 200, so it can't be used to probe
 * whether a token is valid.
 *
 * Only a token that is still LIVE signs out, by the session layer's own
 * rules (getBearerLogin): not revoked, not expired, the row names the
 * token's login, and a token that carries a session epoch is at the login's
 * current epoch (a client's must carry one). A dead copy someone kept ends
 * nothing.
 *
 * The push devices that token enrolled go with it, and so do the login's
 * devices from before tokens were recorded (which phone they are is not
 * known): a signed-out phone gets no more teasers. A CLIENT's sign-out ends
 * every session of the login (its other devices and its browser too), as its
 * web sign-out does (client logins audit B23).
 */
function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

export async function POST(req: Request) {
  const token = bearer(req);
  const claims = token ? verifyMobileToken(token) : null;
  if (claims) {
    const jti = claims.jti;
    const [row] = await db
      .select({
        userId: mobileTokens.userId,
        label: mobileTokens.label,
        revokedAt: mobileTokens.revokedAt,
        expiresAt: mobileTokens.expiresAt,
        email: authUsers.email,
        role: authUsers.role,
        sessionEpoch: authUsers.sessionEpoch,
      })
      .from(mobileTokens)
      .innerJoin(authUsers, eq(authUsers.id, mobileTokens.userId))
      .where(eq(mobileTokens.id, jti))
      .limit(1);
    const isClient = row?.role === 'client';
    const live =
      !!row &&
      !row.revokedAt &&
      row.userId === claims.uid &&
      row.expiresAt.getTime() > Date.now() &&
      (claims.ep === undefined ? !isClient : claims.ep === row.sessionEpoch);
    if (row && live) {
      if (isClient) {
        // Everything at once, in one transaction: the epoch, every token
        // (this one too) and the devices they enrolled.
        await endLoginSessions(row.userId);
      } else {
        await db
          .update(mobileTokens)
          .set({ revokedAt: new Date() })
          .where(eq(mobileTokens.id, jti));
        await forgetRelayDevices([
          ...(await deleteTokenSubscriptions(jti)),
          ...(await deleteLegacySubscriptions(row.userId)),
        ]);
      }
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
          deviceId: jti,
          ...(isClient ? { everywhere: true } : {}),
        },
        ...requestMetaFrom(req),
      });
    }
  }
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
