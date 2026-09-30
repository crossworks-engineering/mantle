import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { deleteRecallMap, updateRecallMap } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { getRecallMapDetail, recallWriteFailure } from '@/lib/recall';
import { firstIssue } from '@/lib/zod-issue';
import { UUID_RE } from '@mantle/std';

/** One map: its cards (without bodies) and options; for a page-built map,
 *  also its last lint report. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const map = await getRecallMapDetail(user.id, id);
  if (!map) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ map });
}

const Patch = z.object({
  title: z.string().min(1).optional(),
  enterWhen: z.string().min(1).optional(),
  /** An explicit slug change. The old slug is kept and keeps resolving. */
  slug: z.string().min(1).optional(),
  published: z.boolean().optional(),
  version: z.number().int().nonnegative(),
});

/** Retitle, re-slug, or publish a native map. A rename does NOT move the
 *  slug: `slug` is its own field because agents and skills remember slugs. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const parsed = Patch.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  try {
    const res = await updateRecallMap(user.id, id, parsed.data, {
      kind: 'owner',
      id: user.actor.id,
      name: user.actor.displayName ?? null,
    });
    return NextResponse.json(res);
  } catch (err) {
    return recallWriteFailure(err);
  }
}

/** Retire a map. The item goes and the cascades take its cards, its map row
 *  and its revisions (migration 0203). */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    await deleteRecallMap(user.id, id, {
      kind: 'owner',
      id: user.actor.id,
      name: user.actor.displayName ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return recallWriteFailure(err);
  }
}
