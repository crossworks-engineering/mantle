/**
 * POST /api/telegram/pair: pair the Telegram chat holding `code` to the
 * signed-in user, in two steps (someone else's code must not quietly pair
 * their chat to you).
 *
 *  - `{ code }`: a preview, nothing paired: TelegramPairPreview, naming the
 *    chat (its checked @username or its id as `label`, its free title as
 *    `title`, at most 64 characters, for plain text only), the bot and its
 *    assistant.
 *  - `{ code, confirm: true, previewToken }`: pairs: TelegramPairResult.
 *    The preview's token is required (400 without it): only the chat
 *    that preview showed, for this code, within ten minutes of it (else 409
 *    preview_mismatch). The user is then told in the app.
 *
 * Only the user pairs their own chat: the code is the one the bot sent them
 * on Telegram, and the chat is paired to this login, never to anyone else,
 * only for a bot whose assistant's workspace this login is a user of. Any
 * login but a client (`open: 'telegram'`).
 *
 * 200 TelegramPairPreview | TelegramPairResult; 400 bad body (a confirm
 * without previewToken too); 403 not a user
 * of the workspace / a client; 404 no such pending code; 409 expired, paired
 * to another user, no assistant, preview mismatch; 429 too many tries.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { chatCaller } from '@/lib/auth';
import {
  pairMyTelegramChat,
  pairingRefusalStatus,
  previewMyTelegramChat,
} from '@/lib/agent-telegram';
import { readJson } from '@/lib/read-body';
import { ownCompanyBearer, ownOidcCookieEnd } from '@/lib/auth/own-device';
import type { OidcRefusal } from '@mantle/client-types';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { RouteSwitches } from '@/lib/auth/route-switches';

export const policy = routePolicy({
  POST: {
    class: 'self',
    open: 'telegram',
    item: { none: "the login's own things, not an item" },
    limits: { rateLimit: ['telegramPair'] },
  },
});
/** Served under the box policy's Telegram switch (MANTLE_POLICY_TELEGRAM=off,
 *  docs/policy.md): the gate answers 403 policy_telegram_off first while it is
 *  off (lib/auth/route-switches.ts). */
export const routeSwitches = { POST: 'telegram-policy' } as const satisfies RouteSwitches;

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
  const login = chatCaller();
  // A chat paired from a session made by company sign-in would act as the
  // login after that session (and a provider block) ended: refused, as
  // pairing a phone is (docs/oidc-sign-in.md).
  if (ownOidcCookieEnd(req) !== null || ownCompanyBearer(req)) {
    const body: OidcRefusal = {
      error: 'A company sign-in session cannot pair a Telegram chat yet.',
      code: 'sso-session',
    };
    return NextResponse.json(body, { status: 403 });
  }
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
