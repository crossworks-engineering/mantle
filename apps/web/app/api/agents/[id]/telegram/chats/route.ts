import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { getAgent } from '@/lib/agents';
import { setAgentTelegramChatStatus, TelegramTokenError } from '@/lib/agent-telegram';

const IdParams = z.object({ id: z.string().uuid() });
const Body = z.object({
  chatId: z.string().uuid(),
  status: z.enum(['allowed', 'denied']),
});

/** Approve (pair) or deny a chat on the agent's linked Telegram bot. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const agent = await getAgent(user.id, idParsed.data.id);
  if (!agent) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });

  try {
    await setAgentTelegramChatStatus(user.id, agent.id, parsed.data.chatId, parsed.data.status);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TelegramTokenError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[telegram chat status]', err);
    return NextResponse.json({ error: 'Could not update the chat.' }, { status: 500 });
  }
}
