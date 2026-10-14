import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { getAgent } from '@/lib/agents';
import { setAgentTelegramChat, TelegramTokenError } from '@/lib/agent-telegram';

const IdParams = z.object({ id: z.string().uuid() });
const Body = z.object({
  chatId: z.string().uuid(),
  /** 'denied' blocks the chat; 'pending' unpairs it (back to pending, no
   *  user). 'allowed' is refused: only the user pairs their own chat, with
   *  its code (POST /api/telegram/pair, workspaces W7d). */
  status: z.enum(['allowed', 'denied', 'pending']),
});

/** The code a refused 'allowed' answers with, so the screen can point the
 *  user at pairing with a code. */
const PAIR_WITH_CODE = 'pair_with_code';

/**
 * Block or unpair a chat on the agent's linked Telegram bot (Settings), by
 * a Moderator of the bot's workspace or an Admin user with the users area.
 * Pairing is the chat's own user's, with its code: 'allowed' answers 403.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const agent = await getAgent(user.id, idParsed.data.id);
  if (!agent) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  if (parsed.data.status === 'allowed') {
    return NextResponse.json(
      {
        error:
          "Only the chat's own user pairs it: signed in, they enter the code the bot sent them.",
        code: PAIR_WITH_CODE,
      },
      { status: 403 },
    );
  }

  try {
    await setAgentTelegramChat({
      ownerId: user.id,
      actorLoginId: user.actor.id,
      agentId: agent.id,
      chatId: parsed.data.chatId,
      action: parsed.data.status === 'denied' ? 'block' : 'unpair',
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TelegramTokenError) {
      return NextResponse.json(
        { error: err.message, ...(err.code ? { code: err.code } : {}) },
        { status: err.code === 'not_found' ? 404 : 400 },
      );
    }
    console.error('[telegram chat status]', err);
    return NextResponse.json({ error: 'Could not update the chat.' }, { status: 500 });
  }
}
