import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import {
  RECALL_LINE_MAX,
  RECALL_TITLE_MAX,
  deleteRecallMap,
  updateRecallMap,
} from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { getRecallMapDetail, recallActorOf } from '@/lib/recall';
import { UUID_RE } from '@mantle/std';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
  PATCH: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'edit' },
  },
  DELETE: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'manage' },
  },
});

/** One map: its cards (without bodies) and options. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const map = await getRecallMapDetail(user.id, id);
  if (!map) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ map });
}

const Patch = z.object({
  title: z.string().min(1).max(RECALL_TITLE_MAX).optional(),
  enterWhen: z.string().min(1).max(RECALL_LINE_MAX).optional(),
  /** An explicit slug change. The old slug is kept and keeps resolving. */
  slug: z.string().min(1).optional(),
  published: z.boolean().optional(),
  version: z.number().int().nonnegative(),
});

/** Retitle, re-slug, or publish a native map. A rename does NOT move the
 *  slug: `slug` is its own field because agents and skills remember slugs. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = await readBody(req, Patch);
  const res = await updateRecallMap(user.id, id, body, await recallActorOf(user));
  return NextResponse.json(res);
}

/** Retire a map. The item goes and the cascades take its cards, its map row
 *  and its revisions (migration 0203). */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  await deleteRecallMap(user.id, id, await recallActorOf(user));
  return NextResponse.json({ ok: true });
}
