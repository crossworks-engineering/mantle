import { NextResponse } from '@/server/http-compat';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db, authUsers, agents, asc, eq, sql } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';
import { cloneAgentForUser } from '@/lib/agents';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';

/**
 * Co-admin login management (Settings → Logins). Logins are NOT tenants: every
 * account operates on the one brain (content stays keyed to the anchor); a row
 * here is just an identity for the audit trail.
 *
 * No permission tiers by design — every login is a full admin (access tiers are
 * a separate team-member surface). These routes emit their own `user.*` audit
 * events (the choke point skips its generic row for /api/users — see
 * AUDIT_SELF_LOGGED_PATHS).
 *
 * A login may optionally own a personal ASSISTANT (migration 0143): a clone of
 * an existing agent, bound via `agents.assigned_user_id`, which becomes that
 * login's default chat target. That splits the conversation stream (keyed
 * (owner_id, agent_id)) so two co-admins chatting at once stop interleaving.
 * It is not a privacy boundary — every login still sees every agent.
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
      agentId: agents.id,
      agentSlug: agents.slug,
      agentName: agents.name,
    })
    .from(authUsers)
    // At most one agent per login (partial unique index on assigned_user_id),
    // so this stays one row per user.
    .leftJoin(agents, eq(agents.assignedUserId, authUsers.id))
    .orderBy(asc(authUsers.createdAt));

  return NextResponse.json({
    users: rows.map(({ agentId, agentSlug, agentName, ...u }) => ({
      ...u,
      agent: agentId ? { id: agentId, slug: agentSlug, name: agentName } : null,
    })),
    currentActorId: user.actor.id,
  });
}

/** The optional personal-assistant clone. (PUT /api/users/[id]/agent carries its
 *  own near-identical schema — a route module may only export route handlers,
 *  so this can't be shared from here.) */
const AgentAssignmentBody = z.object({
  name: z.string().trim().min(1).max(120),
  sourceAgentId: z.string().uuid(),
});

const CreateBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(1024),
  displayName: z.string().trim().min(1).max(120).optional(),
  /** Omit to keep today's behaviour exactly: the login shares the brain's
   *  default agent, as every login did before 0143. */
  agent: AgentAssignmentBody.optional(),
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

  // The assistant is a bonus, not part of the login. If cloning fails (a bad
  // source id, a deleted API key) the login must still exist and be usable —
  // report the failure alongside the 201 and let the operator retry from the
  // user's detail panel.
  let agentError: string | null = null;
  if (parsed.data.agent) {
    try {
      const agent = await cloneAgentForUser(user.id, {
        actorId: id,
        actorEmail: email,
        name: parsed.data.agent.name,
        sourceAgentId: parsed.data.agent.sourceAgentId,
      });
      auditFireAndForget({
        actorId: user.actor.id,
        actorEmail: user.actor.email,
        action: 'user.agent.assign',
        method: 'POST',
        path: '/api/users',
        detail: {
          targetId: id,
          targetEmail: email,
          agentId: agent.id,
          agentSlug: agent.slug,
          sourceAgentId: parsed.data.agent.sourceAgentId,
        },
        ...requestMetaFrom(req),
      });
    } catch (err) {
      console.error('[users] assistant clone failed', err);
      agentError =
        'The login was created, but its assistant could not be. Try again from the user.';
    }
  }

  return NextResponse.json({ ok: true, id, agentError }, { status: 201 });
}
