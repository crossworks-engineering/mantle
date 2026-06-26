import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { listHeartbeats } from '@/lib/heartbeats';

/** List the owner's heartbeats (summaries). Mutations stay on the settings
 *  server actions for now — see docs/phase2-task1-api-gaps.md (group B). */
export async function GET() {
  const user = await requireOwner();
  const heartbeats = await listHeartbeats(user.id);
  return NextResponse.json({ heartbeats });
}
