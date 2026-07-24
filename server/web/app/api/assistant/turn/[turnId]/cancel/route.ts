import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { publishTurnCancel } from '@mantle/turn-stream';
import { isTurnStreamingEnabled } from '@/lib/turn-streaming';

/**
 * POST /api/assistant/turn/[turnId]/cancel — stop an in-flight streamed turn.
 *
 * The user hit Stop. We publish a `turn_cancel` NOTIFY keyed on (owner, turnId);
 * the runner (apps/api) LISTENs, aborts that turn's LLM stream, and finalizes the
 * outbound row with whatever partial reply had streamed. The turn then ends
 * normally (a `done` event), so the client reconciles the same way it does for a
 * completed turn — no special client teardown needed beyond firing this.
 *
 * **Bearer-authed** (same as the stream route), so the detached companion can
 * stop a turn too. Owner isolation is enforced twice: the session gate here, and
 * the (owner, turnId) match inside `abortTurn` on the runner — a turnId guessed
 * from another owner won't abort their turn.
 *
 * **Flagged:** 404s until `MANTLE_TURN_STREAMING` is set (cancellation only
 * matters when the non-blocking streaming path is on).
 */
export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  if (!isTurnStreamingEnabled()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;

  const { turnId } = await ctx.params;
  if (!turnId) return NextResponse.json({ error: 'turnId required' }, { status: 400 });

  // Fire-and-forget across the process boundary; the runner does the actual
  // abort. publishTurnCancel never throws.
  await publishTurnCancel(owner.id, turnId);
  return NextResponse.json({ ok: true });
}
