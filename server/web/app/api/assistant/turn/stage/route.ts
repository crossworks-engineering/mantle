/**
 * GET /api/assistant/turn/stage — the assistant's current activity label.
 *
 * Polled by the chat UI (~1×/s) while a turn is in flight to show what the
 * agent is doing ("Searching the web…", "Delegating to a specialist…") next to
 * the typing dots. Reads the live trace (currentTurnStageLabel); it does NOT
 * touch the turn request/response path. Returns `{ label: null }` when idle.
 * Only the signed-in login's own turn counts.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { currentTurnStageLabel } from '@/lib/assistant/turn-stage';
import { toolMakerFor } from '@/lib/tools';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self' },
});

export async function GET() {
  const user = ownerCaller();
  const label = await currentTurnStageLabel(user.id, toolMakerFor(user));
  return NextResponse.json({ label });
}
