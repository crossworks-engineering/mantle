/**
 * GET /api/assistant/turn/stage — the assistant's current activity label.
 *
 * Polled by the chat UI (~1×/s) while a turn is in flight to show what the
 * agent is doing ("Searching the web…", "Delegating to a specialist…") next to
 * the typing dots. Reads the live trace (currentTurnStageLabel); it does NOT
 * touch the turn request/response path. Returns `{ label: null }` when idle.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { currentTurnStageLabel } from '@/lib/assistant/turn-stage';


export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const label = await currentTurnStageLabel(user.id);
  return NextResponse.json({ label });
}
