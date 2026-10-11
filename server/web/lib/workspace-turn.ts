/**
 * A chat turn with the assistant of a workspace other than Admin (workspaces
 * W7c), queued from POST /api/assistant/turn: the workspace turn engine
 * (runTeamTurn) on the member turn queue, never ahead of the owner's turns.
 * It answers 202 `{ turnId }`; the reply lands in the login's own thread
 * (GET /api/assistant/thread, or the conversation stream).
 *
 * The limits the member chat route had stay, for every login that is not an
 * Admin user: 6 messages a minute, and the daily turn cap and token budget
 * checked when the turn is QUEUED against the member turn ledger (audit F09),
 * so turns waiting on the queue count. A retry with the same Idempotency-Key
 * is the same turn; the key with new text is a 409. The login is baked into
 * the workflow id, so a client can never address another login's turn.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from '@/server/http-compat';
import {
  TEAM_TURN_WORKFLOW,
  MEMBER_TURN_QUEUE,
  type TeamTurnInput,
  type TeamTurnRunResult,
} from '@mantle/runtime/assistant';
import { claimMemberTurn, recordTeamAccess, releaseMemberTurn } from '@mantle/content';
import { errorMessage } from '@mantle/std';
import type { ChatLogin } from './auth';
import type { ChatAgent } from './assistant-chat';
import { getDbosClient } from './dbos-client';
import { MEMBER_DAILY_CAP, MEMBER_DAILY_TOKENS, startOfTodayUtc } from './member-daily-cap';
import { rateLimit } from './rate-limit';

export type WorkspaceTurnResult = { status: number; body: unknown; headers?: HeadersInit };

/** How the assistant sees the user: their name, else the part of their email
 *  before the @. */
function userName(login: ChatLogin): string {
  return login.displayName?.trim() || login.email.split('@')[0] || 'user';
}

export async function queueWorkspaceTurn(o: {
  login: ChatLogin;
  agent: ChatAgent;
  text: string;
  idempotencyKey: string | null;
  /** The live-stream correlation id (an Admin user's client only). */
  streamId?: string;
}): Promise<WorkspaceTurnResult> {
  const { login, agent, text } = o;
  const { ownerId, loginId } = login;
  const limited = login.kind !== 'admin';
  if (limited) {
    const gate = rateLimit(`member-turn:${loginId}`, { max: 6, windowMs: 60_000 });
    if (!gate.ok) {
      return {
        status: 429,
        body: { error: 'too many messages, give me a moment' },
        headers: { 'Retry-After': String(gate.retryAfterSec) },
      };
    }
  }
  const key = o.idempotencyKey?.slice(0, 64) || null;
  const turnId = `ws-${loginId}.${key ?? randomUUID()}`;
  try {
    let fresh = false;
    if (limited) {
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
        return {
          status: 429,
          body: {
            error:
              claim.reason === 'daily_cap'
                ? `daily message limit reached (${MEMBER_DAILY_CAP}/day). Try again tomorrow.`
                : 'daily usage limit reached for the chat. Try again tomorrow, or ask an admin to raise it.',
            reason: claim.reason,
          },
        };
      }
      fresh = claim.fresh;
    }
    const input: TeamTurnInput = {
      ownerId,
      text,
      options: {
        contactName: userName(login),
        channel: 'web',
        loginId,
        agentSlug: agent.slug,
        ...(o.streamId ? { streamId: o.streamId } : {}),
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
      if (fresh) await releaseMemberTurn(turnId).catch(() => undefined);
      throw err;
    }
    // A reused key lands on the turn that key started: DBOS keeps the first
    // input. The same text is a retry (202, same turn); new text would
    // vanish without a word, so it is a 409.
    if (key) {
      const first = (await client.getWorkflow(turnId))?.input?.[0] as TeamTurnInput | undefined;
      if (first && first.text !== input.text) {
        return {
          status: 409,
          body: {
            error: 'that Idempotency-Key was already used for a different message',
            reason: 'idempotency-key-reused',
          },
        };
      }
    }
    if (limited) {
      recordTeamAccess({
        ownerId,
        contactId: null,
        loginId,
        kind: 'turn',
        detail: { chars: text.length, login_id: loginId, agent_slug: agent.slug },
      });
    }
    return { status: 202, body: { turnId: o.streamId ?? turnId } };
  } catch (err) {
    console.error('[assistant/turn] workspace turn:', errorMessage(err));
    return {
      status: 500,
      body: {
        error: 'something went wrong handling that message. The brain admin can see the details.',
      },
    };
  }
}

/**
 * Count one model call a chat makes besides a turn (a chat summary on New
 * chat, Continue or a summary retry; a voice transcription) for a login that
 * is not an Admin user (W7c fix round 1, L2): it takes a slot of the same
 * daily cap and token budget as a turn, in the member turn ledger, so these
 * never become an unmetered way to bill the brain. An Admin user is not
 * limited. Null when admitted, else the 429 answer.
 */
export async function claimMemberChatWork(
  login: ChatLogin,
  what: 'summary' | 'transcribe',
): Promise<NextResponse | null> {
  if (login.kind === 'admin') return null;
  const claim = await claimMemberTurn({
    ownerId: login.ownerId,
    loginId: login.loginId,
    turnId: `${what}-${login.loginId}.${randomUUID()}`,
    since: startOfTodayUtc(),
    limits: { dailyTurns: MEMBER_DAILY_CAP, dailyTokens: MEMBER_DAILY_TOKENS },
  });
  if (claim.ok) return null;
  recordTeamAccess({
    ownerId: login.ownerId,
    contactId: null,
    loginId: login.loginId,
    kind: 'denied',
    detail: { reason: claim.reason, used: claim.used, login_id: login.loginId, what },
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

/** The 202/4xx answer as a response. */
export function workspaceTurnResponse(r: WorkspaceTurnResult): NextResponse {
  return NextResponse.json(r.body, {
    status: r.status,
    ...(r.headers ? { headers: r.headers } : {}),
  });
}
