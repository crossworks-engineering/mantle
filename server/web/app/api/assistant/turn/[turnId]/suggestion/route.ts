import { and, eq } from 'drizzle-orm';
import { db, assistantMessages } from '@mantle/db';
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { suggestionPayload } from '@/lib/turn-suggestion-read';

/**
 * GET /api/assistant/turn/[turnId]/suggestion: the follow-up suggestion for a
 * finalized turn. `turnId` is the OUTBOUND row's id (the client has it from
 * `done` / the poll reconcile). The suggester (apps/api, see turn-suggestion.ts)
 * persists onto that row's `data` jsonb strictly after the turn finalizes, so
 * delivery is deliberately fetch-after-done rather than a post-`done` SSE event:
 * the client tears the stream down on `done` and the trace frees the turn's
 * seq counter, so a late stream event is racy on both ends. The client retries
 * this a couple of times ~1s apart and gives up quietly.
 *
 * 204 while absent, covering "not generated yet", "guards declined", and
 * "row isn't yours/doesn't exist" alike (owner-scoped query; a guessed turnId
 * from another owner learns nothing, matching the stream route's isolation).
 * Not flagged on MANTLE_TURN_STREAMING: the blocking/poll path finalizes turns
 * the same way, so suggestions work there too.
 */

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;

  const { turnId } = await ctx.params;
  // uuid-shape gate: the id column is uuid, and Postgres errors (22P02) on a
  // malformed cast; turn that into a clean client error instead of a 500.
  if (!turnId || !/^[0-9a-f-]{36}$/i.test(turnId)) {
    return NextResponse.json({ error: 'turnId must be a uuid' }, { status: 400 });
  }

  const [row] = await db
    .select({ data: assistantMessages.data })
    .from(assistantMessages)
    .where(and(eq(assistantMessages.id, turnId), eq(assistantMessages.ownerId, owner.id)))
    .limit(1);

  const payload = suggestionPayload(row?.data ?? null);
  if (!payload) return new Response(null, { status: 204 });
  return NextResponse.json(payload);
}
