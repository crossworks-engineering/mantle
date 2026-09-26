import { NextResponse } from '@/server/http-compat';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { agents, db } from '@mantle/db';
import { ASSISTANT_TURN_MAX_CHARS } from '@mantle/client-types/assistant-limits';
import {
  TEAM_RESPONDER_SLUG,
  TEAM_TURN_WORKFLOW,
  RUNNER_QUEUE,
  type TeamTurnInput,
  type TeamTurnRunResult,
} from '@mantle/runtime/assistant';
import { listTeamThread, recordTeamAccess } from '@mantle/content';
import { errorMessage } from '@mantle/std';
import type { MemberChatThread } from '@mantle/client-types';
import { getMemberOr401, type MemberCaller } from '@/lib/auth';
import { getDbosClient } from '@/lib/dbos-client';
import { forumDailySpend, FORUM_DAILY_CAP } from '@/lib/forum-gate';
import { rateLimit } from '@/lib/rate-limit';
import { teamCallerName } from '@/lib/team-chat-gate';
import { firstIssue } from '@/lib/zod-issue';

/**
 * Member chat (member logins, plan section 5): a MEMBER login's own thread
 * with the brain's team-level agent.
 *
 *   GET  /api/member/chat[?before=ISO] -> { agent, messages }
 *   POST /api/member/chat { text }     -> 202 { turnId }; the reply lands in
 *                                         the thread (poll GET).
 *
 * The agent is team-responder, and only once an admin has set it below admin:
 * members chat only with team-level agents, and the turn engine refuses an
 * admin agent for a member too. The turn runs at the agent's level (RLS), so
 * the agent reads only what the member's level may see. One thread per login
 * (team_messages.login_id), never in the owner's assistant stream. Limits: the
 * team surface's per-contact rate and the one shared daily cap.
 */

const tooLong = (length: number) =>
  `message too long: ${length.toLocaleString('en-US')} characters, the limit per turn is ` +
  `${ASSISTANT_TURN_MAX_CHARS.toLocaleString('en-US')}`;
const Body = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'type a message first')
    .max(ASSISTANT_TURN_MAX_CHARS, { error: (iss) => tooLong(String(iss.input).length) }),
});

/** The agent a member chats with, or null while it is still at admin. */
async function memberAgent(member: MemberCaller) {
  const [row] = await db
    .select({ slug: agents.slug, name: agents.name, audience: agents.audience })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, member.anchorId),
        eq(agents.slug, TEAM_RESPONDER_SLUG),
        eq(agents.enabled, true),
      ),
    )
    .limit(1);
  return row && row.audience !== 'admin' ? { slug: row.slug, name: row.name } : null;
}

export async function GET(req: Request) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const before = new URL(req.url).searchParams.get('before') ?? undefined;
  const [agent, rows] = await Promise.all([
    memberAgent(member),
    listTeamThread(member.anchorId, member.contactId ?? '', {
      loginId: member.loginId,
      limit: 50,
      before,
    }),
  ]);
  const body: MemberChatThread = {
    agent,
    linked: !!member.contactId,
    messages: rows.map((r) => ({
      id: r.id,
      direction: r.direction as 'inbound' | 'outbound',
      text: r.text,
      status: r.status,
      // Internals (provider errors, agent config) stay admin-side.
      failed: r.status === 'failed',
      createdAt: r.createdAt.toISOString(),
    })),
  };
  return NextResponse.json(body);
}

export async function POST(req: Request) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const { anchorId: ownerId, contactId } = member;
  if (!contactId) {
    return NextResponse.json(
      { error: 'This login is not linked to a team contact yet: ask the admin to link it.' },
      { status: 409 },
    );
  }
  const agent = await memberAgent(member);
  if (!agent) {
    return NextResponse.json(
      { error: 'Chat is not open yet: the admin has not set a team-level agent.' },
      { status: 409 },
    );
  }

  const gate = rateLimit(`team-turn:${contactId}`, { max: 6, windowMs: 60_000 });
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'too many messages — give me a moment' },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfterSec) } },
    );
  }
  const usedToday = await forumDailySpend(ownerId, contactId);
  if (usedToday >= FORUM_DAILY_CAP) {
    recordTeamAccess({
      ownerId,
      contactId,
      kind: 'denied',
      detail: { reason: 'daily_cap', cap: FORUM_DAILY_CAP, login_id: member.loginId },
    });
    return NextResponse.json(
      { error: `daily message limit reached (${FORUM_DAILY_CAP}/day) — try again tomorrow` },
      { status: 429 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  try {
    // The login is baked into the workflow id, so a client can never address
    // another member's turn; the idempotency key is only the nonce half.
    const nonce = req.headers.get('idempotency-key')?.slice(0, 64) || randomUUID();
    const turnId = `member-${member.loginId}.${nonce}`;
    const input: TeamTurnInput = {
      ownerId,
      text: parsed.data.text,
      options: {
        contactId,
        contactName: member.displayName ?? (await teamCallerName(ownerId, contactId)),
        channel: 'web',
        loginId: member.loginId,
        agentSlug: agent.slug,
      },
    };
    recordTeamAccess({
      ownerId,
      contactId,
      kind: 'turn',
      detail: { chars: parsed.data.text.length, login_id: member.loginId },
    });
    const client = await getDbosClient();
    await client.enqueue<(i: TeamTurnInput) => Promise<TeamTurnRunResult>>(
      { workflowName: TEAM_TURN_WORKFLOW, queueName: RUNNER_QUEUE, workflowID: turnId },
      input,
    );
    return NextResponse.json({ turnId }, { status: 202 });
  } catch (err) {
    console.error('[member/chat]', errorMessage(err));
    return NextResponse.json(
      { error: 'something went wrong handling that message — the brain admin can see the details' },
      { status: 500 },
    );
  }
}
