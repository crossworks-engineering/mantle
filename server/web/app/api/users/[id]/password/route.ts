import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, authUsers, eq } from '@mantle/db';
import type { PasswordResetRefused } from '@mantle/client-types';
import { isLoginRole } from '@mantle/client-types/role-names';
import {
  endLoginSessions,
  setSessionCookie,
  updatePassword,
  ownerCallerWithSource,
} from '@/lib/auth';
import {
  ownCompanyBearer,
  ownCookieOpts,
  ownLiveDeviceJti,
  ownOidcCookieEnd,
} from '@/lib/auth/own-device';
import type { OidcRefusal } from '@mantle/client-types';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { readJson } from '@/lib/read-body';
import { passwordProblem, passwordProblemBody } from '@/lib/auth/password-rule';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'users',
    item: { none: 'manages the users area: the Admin step checks it' },
    limits: { rateLimit: ['passwordReset'] },
    audit: 'own',
  },
});

const IdParams = z.object({ id: z.string().uuid() });
const Body = z.object({ newPassword: z.string().min(8).max(1024) });

/**
 * Admin password reset — no old password required (that's what
 * /api/auth/change-password is for). No permission tiers by design: any login
 * may reset any account, their own included. The audit event is the
 * accountability mechanism. A reset ends every session the target holds
 * resetting your own keeps the device you did it from signed in, as
 * /api/auth/change-password does: the device token it came with, and a
 * cookie that rides with it keeps the web client's short upgrade life,
 * bound to that token (access matrix T14), never a fresh year.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // Throttled per acting login, bcrypt being deliberately slow: the gate
  // took the row's limit (lib/route-limits.ts passwordReset).
  const auth = ownerCallerWithSource();
  const { user, source } = auth;

  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
  }
  // The box password policy's rule (password-rule.ts): with none set, the
  // schema's 8 characters above already answered.
  const weak = passwordProblem(parsed.data.newPassword);
  if (weak) return NextResponse.json(passwordProblemBody(weak), { status: 400 });
  // The schema keeps a path id's case, and Postgres matches a uuid in any
  // case: lowered, so `self` below cannot miss the caller's own login.
  const targetId = idParsed.data.id.toLowerCase();

  const [target] = await db
    .select({ id: authUsers.id, email: authUsers.email, role: authUsers.role })
    .from(authUsers)
    .where(eq(authUsers.id, targetId))
    .limit(1);
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  // Admins and members sign in with a password (the only roles). Named
  // roles only: an unknown role is refused. A member's reset stays: it is a
  // member's only way back in.
  if (!isLoginRole(target.role)) {
    const body: PasswordResetRefused = {
      error: 'This login does not sign in with a password.',
      reason: 'not-a-password-login',
      message: 'This login does not sign in with a password.',
    };
    return NextResponse.json(body, { status: 400 });
  }

  const self = targetId === user.actor.id;
  // A session company sign-in made lasts MANTLE_OIDC_SESSION_HOURS. Resetting
  // its own password with no old password would turn it into a way in that
  // outlives it, and a block at the provider (as pairing a phone would).
  // /api/auth/change-password, which asks for the old one, stays open.
  if (self && (ownOidcCookieEnd(req) !== null || ownCompanyBearer(req))) {
    const body: OidcRefusal = {
      error: 'A company sign-in session cannot reset its own password.',
      code: 'sso-session',
    };
    return NextResponse.json(body, { status: 403 });
  }
  // Before anything is revoked: the caller's own live device token, on a
  // bearer request or riding with the web client's cookie (T15).
  const keepJti = self ? await ownLiveDeviceJti(req, targetId) : null;
  await updatePassword(targetId, parsed.data.newPassword);
  const unboundPeerIds: string[] = [];
  const epoch = await endLoginSessions(targetId, {
    keepJti,
    endKeys: true,
    actorId: user.actor.id,
    unboundPeerIds,
  });

  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'user.password_reset',
    method: 'POST',
    path: `/api/users/${targetId}/password`,
    detail: { targetId, targetEmail: target.email },
    ...requestMetaFrom(req),
  });

  // How many linked brains (peers acting as the login) were unbound: binding
  // one to the same login again restores it (access matrix L12).
  const res = NextResponse.json({ ok: true, peersUnbound: unboundPeerIds.length });
  if (self && source === 'web' && epoch !== null) {
    setSessionCookie(res, req, targetId, epoch, ownCookieOpts(req, keepJti));
  }
  return res;
}
