import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { deleteRecallCard, putRecallCard } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { getRecallCardDetail, recallWriteFailure } from '@/lib/recall';
import { firstIssue } from '@/lib/zod-issue';
import { UUID_RE } from '@mantle/std';

/**
 * One card of a native Recall map. `card` in the path is the card's SLUG, not
 * its id: the slug is the handle every other surface uses (an option's target,
 * `recall_go`), and it is stable across a retitle.
 *
 * PUT replaces `title` and `bodyMd`; `useWhen`, `options` and `prompt` keep the
 * card's value when left out. `slug` is an explicit slug change: the old one
 * keeps resolving and options in the map follow it.
 */
const Option = z.object({
  label: z.string().min(1),
  useWhen: z.string(),
  targetSlug: z.string(),
  targetMap: z.string().optional(),
});

const Card = z.object({
  title: z.string().min(1),
  bodyMd: z.string(),
  useWhen: z.string().optional(),
  prompt: z.boolean().optional(),
  options: z.array(Option).optional(),
  slug: z.string().min(1).optional(),
  version: z.number().int().nonnegative(),
});

const actorOf = (user: { actor: { id: string; displayName?: string | null } }) =>
  ({ kind: 'owner', id: user.actor.id, name: user.actor.displayName ?? null }) as const;

/** The card with its body — what the editor opens. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; card: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id, card } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const found = await getRecallCardDetail(user.id, id, card);
  if (!found) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ card: found });
}

/** Replace the card. `options` replaces the whole list, so the editor sends
 *  it back edited rather than patching one edge. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string; card: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id, card } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const parsed = Card.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const { version, ...input } = parsed.data;
  try {
    const res = await putRecallCard(user.id, id, card, input, actorOf(user), version);
    return NextResponse.json(res);
  } catch (err) {
    return recallWriteFailure(err);
  }
}

/** Remove the card. Options pointing at it go in the same write and come back
 *  in `optionsDropped`, so the editor can say what else changed. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; card: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id, card } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // `Number(null)` is 0, which would pass as a (stale) version and answer 409
  // for a request that never sent one: check presence first.
  const raw = new URL(req.url).searchParams.get('version');
  const version = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isInteger(version) || version < 0) {
    return NextResponse.json(
      { error: "Send the map's current version as ?version=N, so a concurrent edit is not lost." },
      { status: 400 },
    );
  }
  try {
    const res = await deleteRecallCard(user.id, id, card, actorOf(user), version);
    return NextResponse.json(res);
  } catch (err) {
    return recallWriteFailure(err);
  }
}
