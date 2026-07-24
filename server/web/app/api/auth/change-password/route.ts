import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getSessionUser, updatePassword, verifyPassword } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';

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
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }
  // The LOGIN's own credential — always the actor, never the anchor `user.id`
  // (a co-admin changing "their" password must not rewrite the anchor's).
  const actorId = user.actor.id;

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
    const message = parsed.error.issues[0]?.message ?? 'Invalid input.';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const ok = await verifyPassword(actorId, parsed.data.oldPassword);
  if (!ok) {
    return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 401 });
  }

  await updatePassword(actorId, parsed.data.newPassword);
  auditFireAndForget({
    actorId,
    actorEmail: user.actor.email,
    action: 'auth.password_change',
    method: 'POST',
    path: '/api/auth/change-password',
    ...requestMetaFrom(req),
  });
  return NextResponse.json({ ok: true });
}
