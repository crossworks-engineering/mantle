import { NextResponse } from '@/server/http-compat';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { agents, db } from '@mantle/db';
import { ASSISTANT_TURN_MAX_CHARS } from '@mantle/client-types/assistant-limits';
import {
  TEAM_RESPONDER_SLUG,
  TEAM_TURN_WORKFLOW,
  MEMBER_TURN_QUEUE,
  type TeamTurnInput,
  type TeamTurnRunResult,
} from '@mantle/runtime/assistant';
import {
  chatTextsForReader,
  claimMemberTurn,
  listTeamThread,
  recordTeamAccess,
  releaseMemberTurn,
} from '@mantle/content';
import { errorMessage } from '@mantle/std';
import type { MemberChatThread } from '@mantle/client-types';
import { getMemberOr401, type MemberCaller } from '@/lib/auth';
import { getDbosClient } from '@/lib/dbos-client';
import { MEMBER_DAILY_CAP, MEMBER_DAILY_TOKENS, startOfTodayUtc } from '@/lib/member-daily-cap';
import { readJsonNoNul } from '@/lib/strip-nul';
import { rateLimit } from '@/lib/rate-limit';
import { firstIssue } from '@/lib/zod-issue';

/**
 * Member chat (member logins, plan section 5): a MEMBER login's own thread
 * with the brain's team-level agent.
 *
 *   GET  /api/member/chat[?before=ISO] -> { agent, messages }
 *   POST /api/member/chat { text }     -> 202 { turnId }; the reply lands in
 *                                         the thread (poll GET). A retry with
 *                                         the same Idempotency-Key is the same
 *                                         turn; the key with new text, a 409.
 *
 * The agent is team-responder, and only while an admin has set it to team:
 * members chat only with team-level agents, and the turn engine refuses any
 * other level for a member too. The turn runs at the agent's level (RLS), so
 * the agent reads only what the member's level may see. One thread per login
 * (team_messages.login_id), never in the owner's assistant stream. A
 * picture in the thread points at the member's own file or drawing route,
 * and only at an item at team level or below; every other image is left out
 * (chat-images.ts, client logins C6), never an owner route. The login
 * IS the team member: no contact is needed (0167). Limits, per login: 6
 * messages a minute, and the daily turn cap and token budget
 * (member-daily-cap.ts), both checked when the turn is QUEUED against the turn
 * ledger (audit F09), so turns waiting on the queue count. Member turns run on
 * their own queue, never ahead of the owner's (MEMBER_TURN_QUEUE).
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

/** How the agent and the admin see the member: their name, else the part of
 *  their email before the @. Users are the team: no contact is involved. */
function memberName(member: MemberCaller): string {
  return member.displayName?.trim() || member.email.split('@')[0] || 'team member';
}

/** The agent a member chats with, or null while it is not at team level. */
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
  // Exactly team (client logins C4, plan section 8): not admin, and not
  // client or public either (those serve other logins).
  return row && row.audience === 'team' ? { slug: row.slug, name: row.name } : null;
}

export async function GET(req: Request) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const before = new URL(req.url).searchParams.get('before') ?? undefined;
  const [agent, rows] = await Promise.all([
    memberAgent(member),
    // The member's own thread: their private replies in full (admin readers
    // get them redacted, audit S3).
    listTeamThread(member.anchorId, '', {
      loginId: member.loginId,
      limit: 50,
      before,
      withPrivate: true,
    }),
  ]);
  // Every picture points at the member's own routes, and only at an item they
  // may read at the team level (client logins C6): never at an owner route.
  const texts = await chatTextsForReader(
    member.anchorId,
    'team',
    rows.map((r) => r.text),
  );
  const body: MemberChatThread = {
    agent,
    messages: rows.map((r, i) => ({
      id: r.id,
      direction: r.direction as 'inbound' | 'outbound',
      text: texts[i] ?? '',
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
  const { anchorId: ownerId, loginId } = member;
  const agent = await memberAgent(member);
  if (!agent) {
    return NextResponse.json(
      { error: 'Chat is not open yet: the admin has not set a team-level agent.' },
      { status: 409 },
    );
  }

  const gate = rateLimit(`member-turn:${loginId}`, { max: 6, windowMs: 60_000 });
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'too many messages — give me a moment' },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfterSec) } },
    );
  }
  // NUL cannot be stored in Postgres text; strip it here rather than fail the
  // turn after the 202 (audit F14).
  const parsed = Body.safeParse((await readJsonNoNul(req)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  try {
    // The login is baked into the workflow id, so a client can never address
    // another member's turn; the idempotency key is only the nonce half.
    const key = req.headers.get('idempotency-key')?.slice(0, 64) || null;
    const turnId = `member-${member.loginId}.${key ?? randomUUID()}`;
    // The day's budget, checked and taken BEFORE the enqueue (audit F09): a
    // turn counts from the moment it is queued, and a retry with the same key
    // is the same turn, counted once.
    const claim = await claimMemberTurn({
      ownerId,
      loginId,
      turnId,
      since: startOfTodayUtc(),
      limits: { dailyTurns: MEMBER_DAILY_CAP, dailyTokens: MEMBER_DAILY_TOKENS },
    });
    if (!claim.ok) {
      const cap = claim.reason === 'daily_cap' ? MEMBER_DAILY_CAP : MEMBER_DAILY_TOKENS;
      recordTeamAccess({
        ownerId,
        contactId: null,
        loginId,
        kind: 'denied',
        detail: { reason: claim.reason, cap, used: claim.used, login_id: loginId },
      });
      return NextResponse.json(
        {
          error:
            claim.reason === 'daily_cap'
              ? `daily message limit reached (${MEMBER_DAILY_CAP}/day). Try again tomorrow.`
              : 'daily usage limit reached for the chat. Try again tomorrow, or ask an admin to raise it.',
          reason: claim.reason,
        },
        { status: 429 },
      );
    }
    const input: TeamTurnInput = {
      ownerId,
      text: parsed.data.text,
      options: {
        contactName: memberName(member),
        channel: 'web',
        loginId,
        agentSlug: agent.slug,
      },
    };
    const client = await getDbosClient();
    try {
      await client.enqueue<(i: TeamTurnInput) => Promise<TeamTurnRunResult>>(
        { workflowName: TEAM_TURN_WORKFLOW, queueName: MEMBER_TURN_QUEUE, workflowID: turnId },
        input,
      );
    } catch (err) {
      // Not queued: give the slot back (only one this request took).
      if (claim.fresh) await releaseMemberTurn(turnId).catch(() => undefined);
      throw err;
    }
    // A reused key lands on the turn that key started: DBOS keeps the first
    // input and drops this one. The same text is a retry (202, same turn); new
    // text would vanish without a word, so it is a 409. Read after the
    // enqueue, so two racing sends with one key are judged by the winner.
    if (key) {
      const first = (await client.getWorkflow(turnId))?.input?.[0] as TeamTurnInput | undefined;
      if (first && first.text !== input.text) {
        return NextResponse.json(
          {
            error: 'that Idempotency-Key was already used for a different message',
            reason: 'idempotency-key-reused',
          },
          { status: 409 },
        );
      }
    }
    recordTeamAccess({
      ownerId,
      contactId: null,
      loginId,
      kind: 'turn',
      detail: { chars: parsed.data.text.length, login_id: loginId },
    });
    return NextResponse.json({ turnId }, { status: 202 });
  } catch (err) {
    console.error('[member/chat]', errorMessage(err));
    return NextResponse.json(
      { error: 'something went wrong handling that message — the brain admin can see the details' },
      { status: 500 },
    );
  }
}
