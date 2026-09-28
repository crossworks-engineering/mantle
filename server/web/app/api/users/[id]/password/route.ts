import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, authUsers, eq } from '@mantle/db';
import {
  bearerFromHeader,
  endLoginSessions,
  getOwnerOr401WithSource,
  mobileTokenJti,
  setSessionCookie,
  updatePassword,
} from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';

const IdParams = z.object({ id: z.string().uuid() });
const Body = z.object({ newPassword: z.string().min(8).max(1024) });

/**
 * Admin password reset — no old password required (that's what
 * /api/auth/change-password is for). No permission tiers by design: any login
 * may reset any account, their own included. The audit event is the
 * accountability mechanism. A reset ends every session the target holds
 * (F06); resetting your own keeps the device you did it from signed in, as
 * /api/auth/change-password does.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getOwnerOr401WithSource();
  if (auth instanceof NextResponse) return auth;
  const { user, source } = auth;

  // Throttle per acting login — bcrypt is deliberately slow.
  const limit = rateLimit(`users:password-reset:${user.actor.id}`, {
    max: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many password resets. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
  }
  const targetId = idParsed.data.id;

  const [target] = await db
    .select({ id: authUsers.id, email: authUsers.email, role: authUsers.role })
    .from(authUsers)
    .where(eq(authUsers.id, targetId))
    .limit(1);
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  // Admins and members sign in with a password; a client never does (a link
  // or a code, client logins C2), so no password is set on one. Named roles
  // only: an unknown role is refused too.
  if (target.role !== 'admin' && target.role !== 'member') {
    return NextResponse.json(
      { error: 'This login does not sign in with a password.' },
      { status: 400 },
    );
  }

  await updatePassword(targetId, parsed.data.newPassword);
  const self = targetId === user.actor.id;
  const keepJti =
    self && source === 'mobile'
      ? mobileTokenJti(bearerFromHeader(req.headers.get('authorization')) ?? '')
      : null;
  const epoch = await endLoginSessions(targetId, { keepJti });

  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'user.password_reset',
    method: 'POST',
    path: `/api/users/${targetId}/password`,
    detail: { targetId, targetEmail: target.email },
    ...requestMetaFrom(req),
  });

  const res = NextResponse.json({ ok: true });
  if (self && source === 'web' && epoch !== null) setSessionCookie(res, req, targetId, epoch);
  return res;
}
