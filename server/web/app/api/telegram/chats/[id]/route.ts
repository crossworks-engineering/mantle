import { and, eq } from 'drizzle-orm';
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, agents, onFullSystemRoute, telegramChats } from '@mantle/db';
import { chatLoginRefusal, TELEGRAM_NOT_A_USER_CODE } from '@mantle/telegram';
import { ownerCaller } from '@/lib/auth';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { RouteSwitches } from '@/lib/auth/route-switches';

export const policy = routePolicy({
  PATCH: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
});
/** Served under the box policy's Telegram switch (MANTLE_POLICY_TELEGRAM=off,
 *  docs/policy.md): the gate answers 403 policy_telegram_off first while it is
 *  off (lib/auth/route-switches.ts). */
export const routeSwitches = { PATCH: 'telegram-policy' } as const satisfies RouteSwitches;

const IdParams = z.object({ id: z.string().uuid() });

const PatchBody = z
  .object({
    responderAgentId: z.string().uuid().nullable(),
  })
  .partial();

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }

  const raw = await readJson(req);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    const message = firstIssue(parsed.error, 'Invalid input.');
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Verify the chat belongs to this owner.
  const [chat] = await db
    .select({
      id: telegramChats.id,
      accountId: telegramChats.accountId,
      loginId: telegramChats.loginId,
      status: telegramChats.allowlistStatus,
    })
    .from(telegramChats)
    .where(and(eq(telegramChats.id, idParsed.data.id), eq(telegramChats.userId, user.id)))
    .limit(1);
  if (!chat) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  // If setting an override, verify the agent belongs to this owner, and that
  // a paired chat's user is a user of its workspace too: a
  // turn runs as that user, in the workspace of every assistant the chat
  // runs as, so an override never moves a user's chat into a workspace they
  // are not in.
  if (parsed.data.responderAgentId) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, parsed.data.responderAgentId), eq(agents.ownerId, user.id)))
      .limit(1);
    if (!agent) return NextResponse.json({ error: 'Agent not found.' }, { status: 404 });
    if (chat.status === 'allowed' && chat.loginId) {
      const refused = await chatLoginRefusal({
        ownerId: user.id,
        loginId: chat.loginId,
        accountId: chat.accountId,
        responderAgentId: agent.id,
      });
      if (refused === 'not_a_user') {
        return NextResponse.json(
          {
            error:
              "The chat's user is not a user of that assistant's workspace. Add them there first, or pick another assistant.",
            code: TELEGRAM_NOT_A_USER_CODE,
          },
          { status: 400 },
        );
      }
    }
  }

  // Which assistant answers the chat's login is a grant (its tool groups):
  // the narrow login holds no write of telegram_chats, so on a narrow exit
  // the update runs at the full-route spot telegram-responder.
  await onFullSystemRoute('telegram-responder', () =>
    db
      .update(telegramChats)
      .set({
        ...(parsed.data.responderAgentId !== undefined
          ? { responderAgentId: parsed.data.responderAgentId }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(telegramChats.id, idParsed.data.id)),
  );

  return NextResponse.json({ ok: true });
}
