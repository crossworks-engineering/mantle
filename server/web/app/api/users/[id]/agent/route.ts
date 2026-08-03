import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, authUsers, eq } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';
import {
  cloneAgentForUser,
  getAssignedAgent,
  releaseAssignedAgent,
  renameAssignedAgent,
} from '@/lib/agents';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';

/**
 * A login's personal assistant (migration 0143).
 *
 * PUT creates it (cloning an existing agent) or renames the one already there;
 * DELETE only releases the binding. Neither ever deletes an agent — the archive
 * outlives the assignment, same reasoning as migration 0127. Removing the agent
 * row itself stays a deliberate /settings/agents action.
 *
 * Owner-gated like the rest of /api/users, with its own `user.agent.*` audit
 * events (the choke point skips its generic row for /api/users paths).
 */

const IdParams = z.object({ id: z.string().uuid() });

const PutBody = z.object({
  name: z.string().trim().min(1).max(120),
  /** Which agent to clone. Omitted on a pure rename of an existing assistant —
   *  a rename keeps the slug, and therefore the thread. */
  sourceAgentId: z.string().uuid().optional(),
});

async function targetUser(id: string) {
  const [row] = await db
    .select({ id: authUsers.id, email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, id))
    .limit(1);
  return row ?? null;
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof NextResponse) return user;

  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
  const parsed = PutBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter a name for the assistant.' }, { status: 400 });
  }
  const targetId = idParsed.data.id;

  const target = await targetUser(targetId);
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  const { name, sourceAgentId } = parsed.data;

  // No source named → a rename of whatever they already have. Attempted rather
  // than pre-checked, so it works for a DISABLED assistant too (the resolution
  // lookup is enabled-only) and there's no read-then-write gap. Re-cloning here
  // would strand the thread they've been building.
  if (!sourceAgentId) {
    const renamed = await renameAssignedAgent(user.id, targetId, name);
    if (!renamed) {
      return NextResponse.json({ error: 'Choose an agent to copy.' }, { status: 400 });
    }
    auditFireAndForget({
      actorId: user.actor.id,
      actorEmail: user.actor.email,
      action: 'user.agent.rename',
      method: 'PUT',
      path: `/api/users/${targetId}/agent`,
      detail: { targetId, targetEmail: target.email, agentId: renamed.id, name },
      ...requestMetaFrom(req),
    });
    return NextResponse.json({ ok: true, agent: renamed });
  }

  // Whatever they had is released (never deleted) inside cloneAgentForUser —
  // capture it first so the audit row explains the orphan left in
  // /settings/agents.
  const existing = await getAssignedAgent(user.id, targetId);
  let agent;
  try {
    agent = await cloneAgentForUser(user.id, {
      actorId: targetId,
      actorEmail: target.email,
      name,
      sourceAgentId,
    });
  } catch (err) {
    console.error('[users] assistant clone failed', err);
    return NextResponse.json({ error: 'Could not create the assistant.' }, { status: 400 });
  }

  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'user.agent.assign',
    method: 'PUT',
    path: `/api/users/${targetId}/agent`,
    detail: {
      targetId,
      targetEmail: target.email,
      agentId: agent.id,
      agentSlug: agent.slug,
      sourceAgentId,
      // The previous assistant is released, not deleted — record which one so
      // the audit trail explains the orphan sitting in /settings/agents.
      releasedAgentId: existing?.id ?? null,
    },
    ...requestMetaFrom(req),
  });

  return NextResponse.json({ ok: true, agent });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof NextResponse) return user;

  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
  const targetId = idParsed.data.id;

  const target = await targetUser(targetId);
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  const released = await releaseAssignedAgent(user.id, targetId);
  if (!released) {
    return NextResponse.json({ error: 'That login has no assistant.' }, { status: 404 });
  }

  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'user.agent.release',
    method: 'DELETE',
    path: `/api/users/${targetId}/agent`,
    detail: {
      targetId,
      targetEmail: target.email,
      agentId: released.id,
      agentSlug: released.slug,
    },
    ...requestMetaFrom(req),
  });

  return NextResponse.json({ ok: true });
}
