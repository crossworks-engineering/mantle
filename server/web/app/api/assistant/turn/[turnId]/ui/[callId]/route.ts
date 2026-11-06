import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { chatCaller } from '@/lib/auth';
import { turnOpenTo } from '@/lib/turn-access';
import { answerUiCall } from '@mantle/db';
import { AGENT_UI_RESULT_MAX_BYTES, AGENT_UI_WINDOW_ID_RE } from '@mantle/client-types/agent-ui';
import { UUID_RE } from '@mantle/std';
import type { RouteSwitches } from '@/lib/auth/route-switches';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    open: 'chat',
    limits: { rateLimit: ['chatTurnUiAnswer'] },
    item: {
      none: "an agent UI call of the login's own turn, no workspace item: the answer's WHERE holds it to the login, the turn and the window",
    },
  },
});

/**
 * POST /api/assistant/turn/[turnId]/ui/[callId]: the window answers one agent
 * UI call (docs/agent-ui.md).
 *
 *   body { windowId, result }   result: the action's JSON, at most
 *                               AGENT_UI_RESULT_MAX_BYTES (64 KB)
 *   -> 200 { ok: true }         the call is answered; its tool's wait wakes
 *   -> 400                      a body that is not { windowId, result: {...} }
 *   -> 404 { error: 'not found' }   no such call of this login's turn and
 *                                   window (another login's, another turn's,
 *                                   another window's: no detail which)
 *   -> 409 { error: 'conflict' }    answered already, expired, or given up
 *   -> 413                      a result over the cap
 *
 * The rights are the answer's own WHERE (@mantle/db answerUiCall): the
 * session's login, this turn, this window, pending and before expires_at, in
 * one UPDATE. Open to every chat login, as the turn's stream and Stop are
 * (an Admin user's turn and a member's workspace turn both carry the
 * tools), and asked first by the same rule (lib/turn-access.ts turnOpenTo):
 * another login's turn is the same 404 before any lookup.
 * Flagged with the stream: 404 while MANTLE_TURN_STREAMING is off. A
 * member's answers are rate limited (`chatTurnUiAnswer`, 60 a minute; an
 * Admin user's are not), as its stream opens and Stops are.
 */
export const routeSwitches = { POST: 'turn-streaming' } as const satisfies RouteSwitches;

const Body = z.object({
  windowId: z.string().regex(AGENT_UI_WINDOW_ID_RE),
  result: z.record(z.string(), z.unknown()),
});

const NOT_FOUND = { error: 'not found' } as const;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ turnId: string; callId: string }> },
): Promise<Response> {
  const login = chatCaller();
  const { turnId, callId } = await ctx.params;
  if (!turnId || !UUID_RE.test(callId ?? '') || !turnOpenTo(turnId, login)) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'body must be { windowId, result: { ok, ... } }' },
      { status: 400 },
    );
  }
  const { windowId, result } = parsed.data;
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > AGENT_UI_RESULT_MAX_BYTES) {
    return NextResponse.json(
      { error: `result over ${AGENT_UI_RESULT_MAX_BYTES} bytes: send less of the screen` },
      { status: 413 },
    );
  }
  const outcome = await answerUiCall({
    callId,
    turnId,
    loginId: login.loginId,
    windowId,
    result,
  });
  if (outcome === 'done') return NextResponse.json({ ok: true });
  if (outcome === 'not_found') return NextResponse.json(NOT_FOUND, { status: 404 });
  return NextResponse.json({ error: 'conflict' }, { status: 409 });
}
