import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { listAgentOptions } from '@/lib/agents';
import type { AgentOptionDTO } from '@mantle/client-types';

/**
 * Lightweight agent picker options — EVERY agent (slug + name + role), unlike
 * `GET /api/agents` which lists only conversational roles. Heartbeats bind an
 * agentSlug that may be a worker-role agent, so the picker needs the full set.
 */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const agents: AgentOptionDTO[] = await listAgentOptions(user.id);
  return NextResponse.json({ agents });
}
