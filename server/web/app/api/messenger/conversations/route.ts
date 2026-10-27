import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import {
  createMessengerConversation,
  getMessengerConversation,
  listMessengerConversations,
  messengerActorOf,
} from '@/lib/messenger';
import { routePolicy } from '@/lib/auth/route-declaration';
import type {
  MessengerCreateResponse,
  MessengerListResponse,
} from '@mantle/client-types/dto/messenger';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any', limits: { rateLimit: ['messengerRead'] } },
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger conversation, not an item' },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

/** GET /api/messenger/conversations: my one list (plan section 12): people
 *  chats, groups and agent threads, favourites first, then the newest.
 *  `?unread_only=1` keeps the rows with something unread. */
export async function GET(req: Request) {
  const login = anyLoginCaller();
  const unreadOnly = new URL(req.url).searchParams.get('unread_only') === '1';
  const rows = await listMessengerConversations(messengerActorOf(login), { unreadOnly });
  return NextResponse.json({ rows } satisfies MessengerListResponse);
}

const CreateBody = z.object({
  kind: z.enum(['direct', 'group']),
  participants: z.array(z.string().uuid()).max(200),
  title: z.string().max(200).optional(),
  // A group's look; the store checks each (one emoji, an app tint key).
  icon: z.string().max(64).nullable().optional(),
  color: z.string().max(32).nullable().optional(),
});

/** POST /api/messenger/conversations: a direct chat (one other login; an
 *  existing pair answers its chat) or a group, with an optional icon and
 *  colour (a direct chat ignores them). Only people who share a workspace
 *  with me (Admin users: anyone). */
export async function POST(req: Request) {
  const login = anyLoginCaller();
  const body = await readBody(req, CreateBody);
  const actor = messengerActorOf(login);
  const { conversationId, created } = await createMessengerConversation(actor, body);
  const conversation = await getMessengerConversation(actor, conversationId);
  return NextResponse.json({ conversation, created } satisfies MessengerCreateResponse, {
    status: created ? 201 : 200,
  });
}
