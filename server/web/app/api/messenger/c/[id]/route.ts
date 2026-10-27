import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import {
  getMessengerConversation,
  messengerActorOf,
  patchMessengerConversation,
} from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { MessengerConversation } from '@mantle/client-types/dto/messenger';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any', limits: { rateLimit: ['messengerRead'] } },
  PATCH: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger conversation, not an item' },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

/** GET /api/messenger/c/:id: one conversation, its participants, my row. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const conversation = await getMessengerConversation(messengerActorOf(login), id);
  return NextResponse.json({ conversation } satisfies { conversation: MessengerConversation });
}

const PatchBody = z
  .object({
    title: z.string().max(200).nullable().optional(),
    // The store checks each (one emoji, an app tint key).
    icon: z.string().max(64).nullable().optional(),
    color: z.string().max(32).nullable().optional(),
    muted: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.title !== undefined ||
      b.icon !== undefined ||
      b.color !== undefined ||
      b.muted !== undefined,
    'nothing to change',
  );

/** PATCH /api/messenger/c/:id: a group's title, icon and colour (its
 *  admins), my own mute. The picture, the workspace and the agent arrive
 *  with Phases 3 and 4. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const body = await readBody(req, PatchBody);
  const actor = messengerActorOf(login);
  await patchMessengerConversation(actor, id, body);
  const conversation = await getMessengerConversation(actor, id);
  return NextResponse.json({ conversation } satisfies { conversation: MessengerConversation });
}
