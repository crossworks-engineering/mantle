/**
 * POST /api/auth/invite/accept { code, password, email? } (public, under
 * /api/auth): redeem an invite and become a MEMBER login (member logins,
 * Phase 6). Only the 16-char invite code redeems: team codes are retired
 * (migration 0178), so an old 8-char team code is just a wrong code. One
 * transaction creates the login, marks the invite redeemed and writes the
 * team access log (redeemMemberInvite). Then the session cookie is set
 * exactly as POST /api/auth/login sets it.
 *
 * Every failure about the code (unknown, used, revoked, expired, an old team
 * code, a wrong email) is the same 401, so the route is no oracle. A password under 8
 * characters is a 400 before any code is looked at. Rate limited per IP and,
 * on failed codes, for the whole brain, before bcrypt (lib/member-invites.ts).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, authUsers, eq, sql } from '@mantle/db';
import { redeemMemberInvite } from '@mantle/content';
import type { MemberInviteAccepted } from '@mantle/client-types';
import { hashLoginPassword, setSessionCookie } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { inviteFailed, inviteRateLimited } from '@/lib/member-invites';

const AcceptBody = z.object({
  code: z.string().min(1).max(64),
  password: z.string().max(1024),
  email: z.string().trim().max(320).optional(),
});

const INVITE_FAILED_MESSAGE = 'This invite is not valid. Ask for a new one.';

export async function POST(req: Request) {
  const limited = inviteRateLimited(req, 'accept');
  if (limited) return limited;

  const parsed = AcceptBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    inviteFailed('accept');
    return NextResponse.json({ error: INVITE_FAILED_MESSAGE }, { status: 401 });
  }
  if (parsed.data.password.length < 8) {
    return NextResponse.json(
      { error: 'Choose a password of at least 8 characters.' },
      { status: 400 },
    );
  }

  const passwordHash = await hashLoginPassword(parsed.data.password);
  const redeemed = await redeemMemberInvite({
    code: parsed.data.code,
    passwordHash,
    email: parsed.data.email || undefined,
  });
  if (!redeemed) {
    inviteFailed('accept');
    auditFireAndForget({
      actorEmail: parsed.data.email?.toLowerCase() || '(invite)',
      action: 'auth.invite_failed',
      method: 'POST',
      path: '/api/auth/invite/accept',
      ...requestMetaFrom(req),
    });
    return NextResponse.json({ error: INVITE_FAILED_MESSAGE }, { status: 401 });
  }

  await db
    .update(authUsers)
    .set({ lastLoginAt: sql`now()` })
    .where(eq(authUsers.id, redeemed.loginId));
  auditFireAndForget({
    actorId: redeemed.loginId,
    actorEmail: redeemed.email,
    action: 'auth.invite_accepted',
    method: 'POST',
    path: '/api/auth/invite/accept',
    detail: { inviteId: redeemed.inviteId, via: redeemed.via, contactId: redeemed.contactId },
    ...requestMetaFrom(req),
  });

  const body: MemberInviteAccepted = { ok: true, email: redeemed.email };
  const res = NextResponse.json(body);
  setSessionCookie(res, req, redeemed.loginId);
  return res;
}
