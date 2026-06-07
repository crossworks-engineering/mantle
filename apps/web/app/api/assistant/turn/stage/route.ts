/**
 * GET /api/assistant/turn/stage — the assistant's current activity label.
 *
 * Polled by the chat UI (~1×/s) while a turn is in flight to show what the
 * agent is doing ("Searching the web…", "Delegating to a specialist…") next to
 * the typing dots. Reads the live trace (currentTurnStageLabel); it does NOT
 * touch the turn request/response path. Returns `{ label: null }` when idle.
 */
import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { currentTurnStageLabel } from '@/lib/assistant/turn-stage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireOwner();
  const label = await currentTurnStageLabel(user.id);
  return NextResponse.json({ label });
}
