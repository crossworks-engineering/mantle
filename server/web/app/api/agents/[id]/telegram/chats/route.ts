import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { getAgent } from '@/lib/agents';
import { setAgentTelegramChat } from '@/lib/agent-telegram';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'assistants',
    item: { none: 'manages the assistants area: the Admin step checks it' },
  },
});

const IdParams = z.object({ id: z.string().uuid() });
const Body = z.object({
  chatId: z.string().uuid(),
  /** 'denied' blocks the chat; 'pending' unpairs it (back to pending, no
   *  user). 'allowed' is refused: only the user pairs their own chat, with
   *  its code (POST /api/telegram/pair). */
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

  const parsed = Body.safeParse(await readJson(req));
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

  // TelegramTokenError answers by the one table: 404 for a
  // chat not found, else 400; anything else is the opaque 500, logged.
  await setAgentTelegramChat({
    ownerId: user.id,
    actorLoginId: user.actor.id,
    agentId: agent.id,
    chatId: parsed.data.chatId,
    action: parsed.data.status === 'denied' ? 'block' : 'unpair',
  });
  return NextResponse.json({ ok: true });
}
