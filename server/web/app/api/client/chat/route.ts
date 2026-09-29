import { NextResponse } from '@/server/http-compat';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { agents, db } from '@mantle/db';
import { ASSISTANT_TURN_MAX_CHARS } from '@mantle/client-types/assistant-limits';
import {
  CLIENT_RESPONDER_SLUG,
  CLIENT_TURN_QUEUE,
  CLIENT_TURN_WORKFLOW,
  type ClientTurnInput,
  type TeamTurnRunResult,
} from '@mantle/runtime/assistant';
import {
  claimMemberTurn,
  listTeamThread,
  recordTeamAccess,
  releaseMemberTurn,
} from '@mantle/content';
import { errorMessage } from '@mantle/std';
import type { ClientChatThread } from '@mantle/client-types';
import { getClientOr401, type ClientCaller } from '@/lib/auth';
import { getDbosClient } from '@/lib/dbos-client';
import { MEMBER_DAILY_CAP, MEMBER_DAILY_TOKENS, startOfTodayUtc } from '@/lib/member-daily-cap';
import { readJsonNoNul } from '@/lib/strip-nul';
import { rateLimit } from '@/lib/rate-limit';
import { firstIssue } from '@/lib/zod-issue';

/**
 * Client chat (client logins C4, plan section 8): a CLIENT login's own thread
 * with the brain's client-responder. The member chat's twin, never shared
 * with it.
 *
 *   GET  /api/client/chat[?before=ISO] -> ClientChatThread
 *   POST /api/client/chat { text }     -> 202 { turnId }; the reply lands in
 *                                         the thread (poll GET). A retry with
 *                                         the same Idempotency-Key is the same
 *                                         turn; the key with new text, a 409.
 *
 * The agent is client-responder, and only while it is EXACTLY at client
 * level (the turn engine refuses any other level too). The turn runs at
 * client level twice over (the agent's level and the client's own wrap), with
 * the client tools only: what the client reads in the chat is what their
 * portal shows. One thread per login (team_messages.login_id), read here by
 * the session's own login.
 *
 * Limits (decision 7 A): the member caps, per client login: 6 messages a
 * minute, and the daily turn cap and token budget, taken from the turn ledger
 * when the turn is QUEUED. Client turns run on their own queue, partitioned by
 * login, one turn in flight each (CLIENT_TURN_QUEUE). A queued turn carries
 * the session epoch, so a sign-out everywhere or End sessions stops it.
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

/** How the agent and the admins see the client: their name, else the part of
 *  their email before the @. */
function clientName(client: ClientCaller): string {
  return client.displayName?.trim() || client.email.split('@')[0] || 'client';
}

/** The agent a client chats with, or null while none is open to clients. */
async function clientAgent(client: ClientCaller) {
  const [row] = await db
    .select({ slug: agents.slug, name: agents.name, audience: agents.audience })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, client.anchorId),
        eq(agents.slug, CLIENT_RESPONDER_SLUG),
        eq(agents.enabled, true),
      ),
    )
    .limit(1);
  return row && row.audience === 'client' ? { slug: row.slug, name: row.name } : null;
}

export async function GET(req: Request) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const before = new URL(req.url).searchParams.get('before') ?? undefined;
  const [agent, rows] = await Promise.all([
    clientAgent(client),
    // The client's own thread, by the session's login (never a parameter).
    listTeamThread(client.anchorId, '', {
      loginId: client.loginId,
      limit: 50,
      before,
      withPrivate: true,
    }),
  ]);
  const body: ClientChatThread = {
    agent: agent ? { name: agent.name } : null,
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
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const { anchorId: ownerId, loginId } = client;
  const agent = await clientAgent(client);
  if (!agent) {
    return NextResponse.json(
      { error: 'Chat is not open yet.', reason: 'chat-closed' },
      { status: 409 },
    );
  }

  const gate = rateLimit(`client-turn:${loginId}`, { max: 6, windowMs: 60_000 });
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'too many messages, give me a moment', reason: 'rate-limited' },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfterSec) } },
    );
  }
  const parsed = Body.safeParse((await readJsonNoNul(req)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  try {
    // The login is baked into the workflow id, so a caller can never address
    // another login's turn; the idempotency key is only the nonce half.
    const key = req.headers.get('idempotency-key')?.slice(0, 64) || null;
    const turnId = `client-${loginId}.${key ?? randomUUID()}`;
    // The day's budget, checked and taken BEFORE the enqueue: a turn counts
    // from the moment it is queued; a retry with the same key counts once.
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
        detail: { reason: claim.reason, cap, used: claim.used, login_id: loginId, role: 'client' },
      });
      return NextResponse.json(
        {
          error:
            claim.reason === 'daily_cap'
              ? `daily message limit reached (${MEMBER_DAILY_CAP}/day). Try again tomorrow.`
              : 'daily usage limit reached for the chat. Try again tomorrow.',
          reason: claim.reason,
        },
        { status: 429 },
      );
    }
    const input: ClientTurnInput = {
      ownerId,
      text: parsed.data.text,
      options: {
        contactName: clientName(client),
        channel: 'web',
        loginId,
        agentSlug: agent.slug,
        sessionEpoch: client.sessionEpoch,
      },
    };
    const dbos = await getDbosClient();
    try {
      await dbos.enqueue<(i: ClientTurnInput) => Promise<TeamTurnRunResult>>(
        {
          workflowName: CLIENT_TURN_WORKFLOW,
          queueName: CLIENT_TURN_QUEUE,
          workflowID: turnId,
          // One turn in flight per client login (the queue's partition cap).
          queuePartitionKey: loginId,
        },
        input,
      );
    } catch (err) {
      // Not queued: give the slot back (only one this request took).
      if (claim.fresh) await releaseMemberTurn(turnId).catch(() => undefined);
      throw err;
    }
    // A reused key lands on the turn that key started: DBOS keeps the first
    // input. The same text is a retry (202); new text would vanish, so 409.
    if (key) {
      const first = (await dbos.getWorkflow(turnId))?.input?.[0] as ClientTurnInput | undefined;
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
      detail: { chars: parsed.data.text.length, login_id: loginId, role: 'client' },
    });
    return NextResponse.json({ turnId }, { status: 202 });
  } catch (err) {
    console.error('[client/chat]', errorMessage(err));
    return NextResponse.json(
      { error: 'something went wrong handling that message; the team can see the details' },
      { status: 500 },
    );
  }
}
