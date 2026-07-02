import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db, authUsers, asc } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';

/**
 * Co-admin login management (Settings → Users). Logins are NOT tenants: every
 * account operates on the one brain (content stays keyed to the anchor); a row
 * here is an identity for the audit trail plus a read_only flag.
 *
 * No permission tiers by design — any non-read-only login may manage users.
 * Read-only logins are blocked by the getOwnerOr401 mutation choke point.
 * These routes emit their own `user.*` audit events (the choke point skips its
 * generic row for /api/users — see AUDIT_SELF_LOGGED_PATHS).
 */

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof NextResponse) return user;

  const rows = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      displayName: authUsers.displayName,
      readOnly: authUsers.readOnly,
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

  try {
    await db.insert(authUsers).values({
      id,
      email,
      passwordHash,
      displayName: parsed.data.displayName ?? null,
      // Never the anchor — that's the first-run signup only.
      isOwner: false,
    });
  } catch {
    // Unique violation on email is the only expected failure.
    return NextResponse.json(
      { error: 'A user with that email already exists.' },
      { status: 409 },
    );
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
