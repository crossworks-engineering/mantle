import { NextResponse } from '@/server/http-compat';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db, authUsers, asc, sql } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';

/**
 * Co-admin login management (Settings → Users). Logins are NOT tenants: every
 * account operates on the one brain (content stays keyed to the anchor); a row
 * here is just an identity for the audit trail.
 *
 * No permission tiers by design — every login is a full admin (access tiers are
 * a separate team-member surface). These routes emit their own `user.*` audit
 * events (the choke point skips its generic row for /api/users — see
 * AUDIT_SELF_LOGGED_PATHS).
 */

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof NextResponse) return user;

  const rows = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      displayName: authUsers.displayName,
      isOwner: authUsers.isOwner,
      createdAt: authUsers.createdAt,
      lastLoginAt: authUsers.lastLoginAt,
    })
    .from(authUsers)
    .orderBy(asc(authUsers.createdAt));

  return NextResponse.json({ users: rows, currentActorId: user.actor.id });
}

const CreateBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(1024),
  displayName: z.string().trim().min(1).max(120).optional(),
});

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof NextResponse) return user;

  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Enter a valid email and a password of at least 8 characters.' },
      { status: 400 },
    );
  }

  const email = parsed.data.email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const id = randomUUID();

  // Case-insensitive pre-check: login matches on lower(email), but the column's
  // unique constraint is case-sensitive, so a legacy mixed-case row (e.g.
  // `Jay@X.com`) wouldn't block inserting `jay@x.com` and would make that login
  // ambiguous. Reject the collision here. (Same-case dupes still hit the unique
  // constraint below — the try/catch is the race backstop.)
  const [clash] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = ${email}`)
    .limit(1);
  if (clash) {
    return NextResponse.json({ error: 'A user with that email already exists.' }, { status: 409 });
  }

  try {
    await db.insert(authUsers).values({
      id,
      email,
      passwordHash,
      displayName: parsed.data.displayName ?? null,
      // Never the anchor — that's the first-run signup only.
      isOwner: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 23505 = unique_violation (concurrent create of the same email).
    if (msg.includes('duplicate key') || msg.includes('users_email_key')) {
      return NextResponse.json(
        { error: 'A user with that email already exists.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'Could not create the user.' }, { status: 500 });
  }

  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'user.create',
    method: 'POST',
    path: '/api/users',
    detail: { targetId: id, targetEmail: email },
    ...requestMetaFrom(req),
  });

  return NextResponse.json({ ok: true, id }, { status: 201 });
}
