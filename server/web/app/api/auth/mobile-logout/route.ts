import { NextResponse } from '@/server/http-compat';
import { db, authUsers, mobileTokens, eq, onLoginHoldSpot } from '@mantle/db';
import { forgetRequestLogins, verifyMobileToken } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { deleteTokenSubscriptions, forgetRelayDevices } from '@/lib/push/store';

/**
 * Revoke the calling device's mobile token. Self-authenticates from the
 * Authorization: Bearer token (its `jti`), so it lives under the public
 * /api/auth prefix. Idempotent — always 200, so it can't be used to probe
 * whether a token is valid.
 *
 * Only a token that is still LIVE signs out, by the session layer's own
 * rules (getBearerLogin): not revoked, not expired, the row names the
 * token's login, and a token that carries a session epoch is at the login's
 * current epoch. A dead copy someone kept ends nothing.
 *
 * The push devices that token enrolled go with it, and only those: the web
 * and desktop client signs out here as well, so a login's devices from
 * before tokens were recorded stay (End sessions, a password change, a
 * disable and a device revoke take them).
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
        sessionEpoch: authUsers.sessionEpoch,
      })
      .from(mobileTokens)
      .innerJoin(authUsers, eq(authUsers.id, mobileTokens.userId))
      .where(eq(mobileTokens.id, jti))
      .limit(1);
    const live =
      !!row &&
      !row.revokedAt &&
      row.userId === claims.uid &&
      row.expiresAt.getTime() > Date.now() &&
      (claims.ep === undefined || claims.ep === row.sessionEpoch);
    if (row && live) {
      // The owner's or an Admin user's own device on a narrow exit: at the
      // spot login-credential (0326's hold on grants).
      await onLoginHoldSpot(row.userId, () =>
        db.update(mobileTokens).set({ revokedAt: new Date() }).where(eq(mobileTokens.id, jti)),
      );
      // This request's own token: a later guard read finds it afresh (L1).
      forgetRequestLogins();
      // Only the devices THIS token enrolled. The web and desktop client
      // signs out here too (with its own bearer), and the login's phone
      // from before tokens were recorded must not lose its pushes for it.
      await forgetRelayDevices(await deleteTokenSubscriptions(jti));
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
        },
        ...requestMetaFrom(req),
      });
    }
  }
  return NextResponse.json({ ok: true });
}
