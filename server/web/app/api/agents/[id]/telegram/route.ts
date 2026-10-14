import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { getAgent } from '@/lib/agents';
import {
  connectAgentTelegram,
  disconnectAgentTelegram,
  getAgentTelegram,
  listAgentTelegramChats,
} from '@/lib/agent-telegram';
import { readJson } from '@/lib/read-body';

const IdParams = z.object({ id: z.string().uuid() });
const ConnectBody = z.object({ token: z.string().min(10).max(200) });

async function resolveAgent(ownerId: string, raw: unknown) {
  const parsed = IdParams.safeParse(raw);
  if (!parsed.success)
    return { error: NextResponse.json({ error: 'Invalid id.' }, { status: 400 }) };
  const agent = await getAgent(ownerId, parsed.data.id);
  if (!agent) return { error: NextResponse.json({ error: 'Not found.' }, { status: 404 }) };
  return { agent };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { agent, error } = await resolveAgent(user.id, await ctx.params);
  if (error) return error;
  const binding = await getAgentTelegram(user.id, agent.id);
  const chats = binding ? await listAgentTelegramChats(user.id, agent.id) : [];
  return NextResponse.json({ binding, chats });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { agent, error } = await resolveAgent(user.id, await ctx.params);
  if (error) return error;
  const parsed = ConnectBody.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ error: 'Paste a bot token.' }, { status: 400 });
  // A problem the owner fixes (TelegramTokenError) answers 400 by the one
  // table (A10 part 2); anything else is the opaque 500, logged.
  const binding = await connectAgentTelegram(user.id, agent.id, parsed.data.token);
  return NextResponse.json({ binding });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { agent, error } = await resolveAgent(user.id, await ctx.params);
  if (error) return error;
  await disconnectAgentTelegram(user.id, agent.id);
  return NextResponse.json({ ok: true });
}
