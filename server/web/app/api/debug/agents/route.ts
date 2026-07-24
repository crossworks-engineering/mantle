import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { listAgentActivity, listPersonaNotes } from '@/lib/debug';

/** GET /api/debug/agents — configured agents + the reflector's persona notes. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [agents, personaNotes] = await Promise.all([
    listAgentActivity(user.id),
    listPersonaNotes(user.id),
  ]);
  return NextResponse.json({ agents, personaNotes });
}
