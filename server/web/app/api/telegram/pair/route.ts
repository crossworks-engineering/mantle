/**
 * POST /api/telegram/pair: pair the Telegram chat holding `code` to the
 * signed-in user (workspaces W7d; the owner's answer 1A), in two steps (W7d
 * fix round 1, M3: someone else's code must not quietly pair their chat to
 * you).
 *
 *  - `{ code }`: a preview, nothing paired: TelegramPairPreview, naming the
 *    chat (its checked @username or its id as `label`, its free title as
 *    `title`, at most 64 characters, for plain text only), the bot and its
 *    assistant.
 *  - `{ code, confirm: true, previewToken }`: pairs: TelegramPairResult.
 *    The preview's token is required (W7d+e; 400 without it): only the chat
 *    that preview showed, for this code, within ten minutes of it (else 409
 *    preview_mismatch). The user is then told in the app.
 *
 * Only the user pairs their own chat: the code is the one the bot sent them
 * on Telegram, and the chat is paired to this login, never to anyone else,
 * only for a bot whose assistant's workspace this login is a user of. Any
 * login but a client (TELEGRAM_LOGIN_ROUTES).
 *
 * 200 TelegramPairPreview | TelegramPairResult; 400 bad body (a confirm
 * without previewToken too); 403 not a user
 * of the workspace / a client; 404 no such pending code; 409 expired, paired
 * to another user, no assistant, preview mismatch; 429 too many tries.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { chatLoginCaller } from '@/lib/auth';
import {
  pairMyTelegramChat,
  pairingRefusalStatus,
  previewMyTelegramChat,
} from '@/lib/agent-telegram';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    open: 'telegram',
    item: { none: "the login's own things, not an item" },
    limits: { rateLimit: ['telegramPair'] },
  },
});

const Body = z
  .object({
    code: z.string().regex(/^[a-fA-F0-9]{6}$/),
    confirm: z.boolean().optional(),
    previewToken: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
  })
  // A confirm carries the preview's token (W7d+e): the user saw whose chat
  // it is first.
  .refine((b) => b.confirm !== true || b.previewToken !== undefined, {
    path: ['previewToken'],
  });

export async function POST(req: Request) {
  // The gate took the row's per-login limit (lib/route-limits.ts
  // telegramPair).
  const login = chatLoginCaller();
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          'code must be six hex digits, and a confirm needs the previewToken the preview gave.',
      },
      { status: 400 },
    );
  }
  const who = { ownerId: login.ownerId, loginId: login.loginId, code: parsed.data.code };
  const r =
    parsed.data.confirm === true
      ? await pairMyTelegramChat({ ...who, previewToken: parsed.data.previewToken ?? '' })
      : await previewMyTelegramChat(who);
  if (!r.ok) {
    return NextResponse.json({ error: r.error, code: r.code }, { status: pairingRefusalStatus(r) });
  }
  return NextResponse.json(r);
}
