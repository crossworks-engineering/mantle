import { NextResponse } from '@/server/http-compat';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  isUniqueViolation,
  pgConstraint,
  db,
  authUsers,
  agents,
  and,
  asc,
  eq,
  nodes,
  sql,
} from '@mantle/db';
import {
  FORMER_CLIENT_CONTACT_MESSAGE,
  FORMER_CLIENT_EMAIL_MESSAGE,
  isFormerClientContact,
  isFormerClientEmail,
} from '@mantle/content';
import { hashLoginPassword, ownerCaller } from '@/lib/auth';
import { cloneAgentForUser } from '@/lib/agents';
import { insertLoginWithWorkspaces } from '@/lib/login-create';
import { LoginRoleSchema } from '@/lib/login-update';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { readJson } from '@/lib/read-body';

/**
 * Co-admin login management (Settings → Logins). Logins are NOT tenants: every
 * account operates on the one brain (content stays keyed to the anchor); a row
 * here is just an identity for the audit trail.
 *
 * Two roles (member logins, Phase 1): an ADMIN login is a full co-owner; a
 * MEMBER login is refused by every admin route
 * and reads team-level items through the member routes. These routes emit
 * their own `user.*` audit
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
  const user = ownerCaller();

  const rows = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      displayName: authUsers.displayName,
      isOwner: authUsers.isOwner,
      role: authUsers.role,
      contactId: authUsers.contactId,
      disabledAt: authUsers.disabledAt,
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
   *  default agent, as every login did before 0143. Admins only. */
  agent: AgentAssignmentBody.optional(),
  /** Default member: an admin login (a full co-owner) is only ever made
   *  when asked for by name (W5a fix round 3). */
  role: LoginRoleSchema.optional(),
  /** The team contact a member login belongs to. */
  contactId: z.string().uuid().optional(),
});

export async function POST(req: Request) {
  const user = ownerCaller();

  const parsed = CreateBody.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Enter a valid email and a password of at least 8 characters.' },
      { status: 400 },
    );
  }

  const role = parsed.data.role ?? 'member';
  if (role === 'member') {
    if (parsed.data.agent) {
      return NextResponse.json(
        {
          error:
            'A member login cannot own a personal assistant: members chat with team-level agents.',
        },
        { status: 400 },
      );
    }
    // Users are the team (Jason, 2026-09-26): a member login IS the team
    // member. It needs no contact; its name is the login's display name.
  }
  if (parsed.data.contactId) {
    const [contact] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.id, parsed.data.contactId),
          eq(nodes.ownerId, user.id),
          eq(nodes.type, 'contact'),
        ),
      )
      .limit(1);
    if (!contact) return NextResponse.json({ error: 'Contact not found.' }, { status: 400 });
    // A former client's contact (archived by 0272, its login deleted or
    // not): a new login on it would bring the client back (W8a fix round 2).
    if (await isFormerClientContact(parsed.data.contactId)) {
      return NextResponse.json(
        { error: FORMER_CLIENT_CONTACT_MESSAGE, reason: 'contact-was-client' },
        { status: 409 },
      );
    }
  }

  const email = parsed.data.email.trim().toLowerCase();
  // A former client (archived by 0272) never comes back as a login by
  // itself, even after its row was deleted (W8a fix round 1).
  if (await isFormerClientEmail(email)) {
    return NextResponse.json(
      { error: FORMER_CLIENT_EMAIL_MESSAGE, reason: 'email-was-client' },
      { status: 409 },
    );
  }
  const passwordHash = await hashLoginPassword(parsed.data.password);
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
    // With its Admin and Team rows for the role, in the same transaction.
    await insertLoginWithWorkspaces({
      id,
      email,
      passwordHash,
      displayName: parsed.data.displayName ?? null,
      // Never the anchor: that's the first-run signup only.
      isOwner: false,
      role,
      contactId: parsed.data.contactId ?? null,
    });
  } catch (err) {
    // 23505 = unique_violation. Two rules on auth.users can fire: the contact
    // (one login per contact, 0181; not pre-checked above) and the email
    // (the race behind the pre-check).
    if (isUniqueViolation(err) && pgConstraint(err) === 'users_contact_id_unique') {
      return NextResponse.json(
        { error: 'That contact is already linked to another user.' },
        { status: 409 },
      );
    }
    if (isUniqueViolation(err)) {
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
    detail: { targetId: id, targetEmail: email, role },
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
