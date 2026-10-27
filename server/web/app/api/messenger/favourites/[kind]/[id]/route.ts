import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readJson } from '@/lib/read-body';
import {
  messengerActorOf,
  notFound,
  removeMessengerFavourite,
  setMessengerFavourite,
} from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  PUT: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: "the login's own pin of its list, not an item" },
    limits: { rateLimit: ['messengerWrite'] },
  },
  DELETE: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: "the login's own pin of its list, not an item" },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

const Kind = z.enum(['conversation', 'agent']);
const PinBody = z.object({ rank: z.number().int().min(0).max(1_000_000).optional() }).optional();

/** PUT /api/messenger/favourites/:kind/:id {rank?}: pin a conversation I
 *  am in, or an agent thread I may hold. */
export async function PUT(req: Request, ctx: { params: Promise<{ kind: string; id: string }> }) {
  const login = anyLoginCaller();
  const { kind, id } = await ctx.params;
  const k = Kind.safeParse(kind);
  if (!k.success) return notFound();
  const raw = await readJson(req).catch(() => undefined);
  const body = PinBody.safeParse(raw ?? undefined);
  if (!body.success) return NextResponse.json({ error: 'rank is a whole number' }, { status: 400 });
  await setMessengerFavourite(messengerActorOf(login), k.data, id, body.data?.rank ?? 0);
  return NextResponse.json({ ok: true });
}

/** DELETE /api/messenger/favourites/:kind/:id: unpin. */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ kind: string; id: string }> },
) {
  const login = anyLoginCaller();
  const { kind, id } = await ctx.params;
  const k = Kind.safeParse(kind);
  if (!k.success) return notFound();
  await removeMessengerFavourite(messengerActorOf(login), k.data, id);
  return NextResponse.json({ ok: true });
}
