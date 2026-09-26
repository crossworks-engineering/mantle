import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getLoginOr401, updatePassword, verifyPassword } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { firstIssue } from '@/lib/zod-issue';

const ChangePasswordBody = z
  .object({
    oldPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(8).max(1024),
  })
  .refine((d) => d.oldPassword !== d.newPassword, {
    message: 'New password must be different from the current one.',
    path: ['newPassword'],
  });

export async function POST(req: Request) {
  // Admin or member: a login changes its own password.
  const login = await getLoginOr401();
  if (login instanceof NextResponse) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }
  // The LOGIN's own credential — always the login, never the anchor
  // (a co-admin changing "their" password must not rewrite the anchor's).
  const actorId = login.loginId;

  // Throttle even with a valid session — a hijacked cookie should not
  // be able to pin bcrypt CPU. 5/hour per user comfortably fits any
  // honest workflow.
  const limit = rateLimit(`auth:change-password:${actorId}`, {
    max: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many password change attempts. Try again later.' },
      {
        status: 429,
        headers: { 'Retry-After': String(limit.retryAfterSec) },
      },
    );
  }

  const raw = await req.json().catch(() => ({}));
  const parsed = ChangePasswordBody.safeParse(raw);
  if (!parsed.success) {
    const message = firstIssue(parsed.error, 'Invalid input.');
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const ok = await verifyPassword(actorId, parsed.data.oldPassword);
  if (!ok) {
    return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 401 });
  }

  await updatePassword(actorId, parsed.data.newPassword);
  auditFireAndForget({
    actorId,
    actorEmail: login.email,
    action: 'auth.password_change',
    method: 'POST',
    path: '/api/auth/change-password',
    ...requestMetaFrom(req),
  });
  return NextResponse.json({ ok: true });
}
