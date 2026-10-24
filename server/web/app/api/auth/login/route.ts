import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, authUsers, eq, sql } from '@mantle/db';
import { authenticatePassword, setSessionCookie } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    public: true,
    item: { none: "the login's own things, not an item" },
    limits: { crossSite: 'json', rateLimit: ['authLogin'] },
  },
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(1024),
});

/** Single message for every failure so the response can't be used to
 *  enumerate which emails exist or distinguish a malformed body from a
 *  wrong password. */
const AUTH_FAILED_MESSAGE = 'Invalid email or password.';

export async function POST(req: Request) {
  // The gate refused a cross-site post and took the row's limit first
  // (this file's `limits`: authLogin, 10 a minute per address,
  // before bcrypt so a flood cannot pin the CPU).
  const raw = (await readJson(req)) ?? {};
  const parsed = LoginBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: AUTH_FAILED_MESSAGE }, { status: 401 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const login = await authenticatePassword(email, parsed.data.password);
  if (!login) {
    // No actor id — the attempted email may not even exist. The row's
    // per-address limit caps how fast this can grow the trail.
    auditFireAndForget({
      actorEmail: email,
      action: 'auth.login_failed',
      method: 'POST',
      path: '/api/auth/login',
      ...requestMetaFrom(req),
    });
    return NextResponse.json({ error: AUTH_FAILED_MESSAGE }, { status: 401 });
  }

  const userId = login.id;
  await db
    .update(authUsers)
    .set({ lastLoginAt: sql`now()` })
    .where(eq(authUsers.id, userId));
  auditFireAndForget({
    actorId: userId,
    actorEmail: email,
    action: 'auth.login',
    method: 'POST',
    path: '/api/auth/login',
    ...requestMetaFrom(req),
  });

  const res = NextResponse.json({ ok: true });
  setSessionCookie(res, req, userId, login.sessionEpoch);
  return res;
}
