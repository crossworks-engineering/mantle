import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { resolveAssistantAgent } from '@/lib/assistant';
import { markAssistantRead } from '@/lib/assistant-inbox';

const Body = z.object({
  agentSlug: z.string().min(1).optional(),
  /** Mark read up to this instant (ISO). Defaults to now. */
  at: z.string().datetime().optional(),
});

/**
 * POST /api/assistant/read — mark an agent's thread read (clears its unread
 * count). `{ agentSlug?, at? }`; omitting agentSlug marks the default agent.
 * Owner-gated → works with a mobile bearer token.
 */
export async function POST(req: Request) {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const body = parsed.data;

  const agent = await resolveAssistantAgent(owner.id, body.agentSlug);
  if (!agent) {
    return NextResponse.json({ error: 'no_agent' }, { status: 404 });
  }

  const at = body.at ? new Date(body.at) : new Date();
  await markAssistantRead(owner.id, agent.id, at);
  return NextResponse.json({ ok: true, agentSlug: agent.slug, lastReadAt: at.toISOString() });
}
