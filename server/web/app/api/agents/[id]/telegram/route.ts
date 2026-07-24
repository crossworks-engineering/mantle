import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { getAgent } from '@/lib/agents';
import {
  connectAgentTelegram,
  disconnectAgentTelegram,
  getAgentTelegram,
  listAgentTelegramChats,
  TelegramTokenError,
} from '@/lib/agent-telegram';

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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { agent, error } = await resolveAgent(user.id, await ctx.params);
  if (error) return error;
  const binding = await getAgentTelegram(user.id, agent.id);
  const chats = binding ? await listAgentTelegramChats(user.id, agent.id) : [];
  return NextResponse.json({ binding, chats });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { agent, error } = await resolveAgent(user.id, await ctx.params);
  if (error) return error;
  const parsed = ConnectBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Paste a bot token.' }, { status: 400 });
  try {
    const binding = await connectAgentTelegram(user.id, agent.id, parsed.data.token);
    return NextResponse.json({ binding });
  } catch (err) {
    if (err instanceof TelegramTokenError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[telegram connect]', err);
    return NextResponse.json({ error: 'Could not link the bot.' }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { agent, error } = await resolveAgent(user.id, await ctx.params);
  if (error) return error;
  await disconnectAgentTelegram(user.id, agent.id);
  return NextResponse.json({ ok: true });
}
