import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { publishTurnCancel } from '@mantle/turn-stream';
import { isTurnStreamingEnabled } from '@mantle/client-types/turn-streaming';
import { markTurnSuperseded } from '@mantle/runtime/agent';
import { UUID_RE } from '@mantle/std';

/**
 * POST /api/assistant/turn/[turnId]/cancel — stop an in-flight streamed turn.
 *
 * The user hit Stop. We publish a `turn_cancel` NOTIFY keyed on (owner, turnId);
 * the runner (server/api) LISTENs, aborts that turn's LLM stream, and finalizes the
 * outbound row with whatever partial reply had streamed. The turn then ends
 * normally (a `done` event), so the client reconciles the same way it does for a
 * completed turn — no special client teardown needed beyond firing this.
 *
 * **Supersede** (the premature-Enter correction flow): the body may carry
 * `{ supersede: { inboundId, outboundId, newTurnId } }` — the durable row ids of
 * the cancelled pair plus the id of the combined turn about to replace it. Both
 * rows are stamped `data.superseded_by = newTurnId` BEFORE the cancel is
 * published, and the client AWAITS this response before POSTing the combined
 * turn — that ordering is the race fix: the new turn's context load excludes the
 * pair no matter when the old turn's finalize lands (finalize merges `data`, so
 * the stamp survives it). The UPDATE is owner-scoped, so foreign ids no-op.
 *
 * **Bearer-authed** (same as the stream route), so the detached companion can
 * stop a turn too. Owner isolation is enforced twice: the session gate here, and
 * the (owner, turnId) match inside `abortTurn` on the runner — a turnId guessed
 * from another owner won't abort their turn.
 *
 * **Flagged:** 404s until `MANTLE_TURN_STREAMING` is set (cancellation only
 * matters when the non-blocking streaming path is on).
 */

type CancelBody = {
  supersede?: { inboundId?: unknown; outboundId?: unknown; newTurnId?: unknown };
};

/** The row ids hit a uuid column — reject non-uuids up front (400, not a
 *  Postgres cast error). `newTurnId` is the client-minted idempotency key,
 *  also a uuid. */

export async function POST(
  req: Request,
  ctx: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  if (!isTurnStreamingEnabled()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;

  const { turnId } = await ctx.params;
  if (!turnId) return NextResponse.json({ error: 'turnId required' }, { status: 400 });

  // Optional supersede payload. The body is absent on a plain Stop; tolerate
  // (and ignore) anything unparseable rather than failing the cancel.
  const body = (await req.json().catch(() => null)) as CancelBody | null;
  const s = body?.supersede;
  let superseded = 0;
  if (s) {
    const { inboundId, outboundId, newTurnId } = s;
    if (
      typeof inboundId !== 'string' ||
      typeof outboundId !== 'string' ||
      typeof newTurnId !== 'string' ||
      !UUID_RE.test(inboundId) ||
      !UUID_RE.test(outboundId) ||
      !UUID_RE.test(newTurnId)
    ) {
      return NextResponse.json({ error: 'invalid supersede payload' }, { status: 400 });
    }
    // Synchronous, BEFORE the publish — see the route doc above.
    superseded = await markTurnSuperseded({
      ownerId: owner.id,
      inboundId,
      outboundId,
      newTurnId,
    });
  }

  // Fire-and-forget across the process boundary; the runner does the actual
  // abort. publishTurnCancel never throws.
  await publishTurnCancel(owner.id, turnId);
  return NextResponse.json({ ok: true, superseded });
}
