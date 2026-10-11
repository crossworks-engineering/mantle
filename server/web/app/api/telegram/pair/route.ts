/**
 * POST /api/telegram/pair: pair the Telegram chat holding `code` to the
 * signed-in user (workspaces W7d; the owner's answer 1A). Only the user
 * pairs their own chat: the code is the one the bot sent them on Telegram,
 * and the chat is paired to this login, never to anyone else, only for a
 * bot whose assistant's workspace this login is a user of. Any login but a
 * client (TELEGRAM_LOGIN_ROUTES).
 *
 * 200 TelegramPairResult; 400 bad code; 403 not a user of the workspace /
 * a client; 404 no such pending code; 409 expired, paired to another user,
 * no assistant; 429 too many tries.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getChatLoginOr401 } from '@/lib/auth';
import { pairMyTelegramChat, pairingRefusalStatus } from '@/lib/agent-telegram';
import { rateLimit } from '@/lib/rate-limit';

const Body = z.object({ code: z.string().regex(/^[a-fA-F0-9]{6}$/) });

export async function POST(req: Request) {
  const login = await getChatLoginOr401();
  if (login instanceof NextResponse) return login;
  if (login.kind === 'client') {
    return NextResponse.json(
      { error: 'this login cannot pair a Telegram chat.', code: 'not_allowed' },
      { status: 403 },
    );
  }
  const gate = rateLimit(`telegram-pair:${login.loginId}`, { max: 10, windowMs: 60_000 });
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'too many tries, wait a moment.', code: 'too_many_attempts' },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfterSec) } },
    );
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'code must be six hex digits.' }, { status: 400 });
  }
  const r = await pairMyTelegramChat({
    ownerId: login.ownerId,
    loginId: login.loginId,
    code: parsed.data.code,
  });
  if (!r.ok) {
    return NextResponse.json({ error: r.error, code: r.code }, { status: pairingRefusalStatus(r) });
  }
  return NextResponse.json(r);
}
