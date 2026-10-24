import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { confirmRecallPrompt } from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { recallActorOf } from '@/lib/recall';
import { UUID_RE } from '@mantle/std';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

/**
 * Confirm (or drop) a prompt.
 *
 * This route is the human act the whole design turns on: an agent may write
 * what the brain KNOWS, but only the owner decides what the brain TELLS other
 * agents to do. Until this is called, an agent's `prompt: true` is only a
 * recorded request and the card never matches.
 */
const Body = z.object({
  confirm: z.boolean(),
  version: z.number().int().nonnegative(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string; card: string }> }) {
  const user = ownerCaller();
  const { id, card } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = await readBody(req, Body);
  const res = await confirmRecallPrompt(
    user.id,
    id,
    card,
    body.confirm,
    await recallActorOf(user),
    body.version,
  );
  return NextResponse.json(res);
}
