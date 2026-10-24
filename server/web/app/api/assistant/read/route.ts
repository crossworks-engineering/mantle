import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { chatCaller } from '@/lib/auth';
import { resolveChatAgentToWrite } from '@/lib/assistant-chat';
import { markAssistantRead } from '@/lib/assistant-inbox';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: { class: 'self', open: 'chat', item: { none: "the login's own things, not an item" } },
});

const Body = z.object({
  agentSlug: z.string().min(1).optional(),
  /** Mark read up to this instant (ISO). Defaults to now. */
  at: z.string().datetime().optional(),
});

/**
 * POST /api/assistant/read — mark an agent's thread read (clears its unread
 * count). `{ agentSlug?, at? }`; omitting agentSlug marks this login's assigned
 * assistant, else the brain default.
 * Owner-gated → works with a mobile bearer token.
 */
export async function POST(req: Request) {
  const login = chatCaller();

  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const body = parsed.data;

  const agent = await resolveChatAgentToWrite(login, body.agentSlug);
  if (!agent) {
    return NextResponse.json({ error: 'no_agent' }, { status: 404 });
  }

  const at = body.at ? new Date(body.at) : new Date();
  await markAssistantRead(login.ownerId, agent.id, login.loginId, at);
  return NextResponse.json({ ok: true, agentSlug: agent.slug, lastReadAt: at.toISOString() });
}
