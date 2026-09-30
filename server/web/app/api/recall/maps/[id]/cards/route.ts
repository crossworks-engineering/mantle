import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { putRecallCard } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { recallWriteFailure } from '@/lib/recall';
import { firstIssue } from '@/lib/zod-issue';
import { UUID_RE } from '@mantle/std';

/** Add a card. The slug comes from the title; `after` places it. Replacing an
 *  existing card is PUT on the card itself. */
const NewCard = z.object({
  title: z.string().min(1),
  bodyMd: z.string(),
  useWhen: z.string().optional(),
  prompt: z.boolean().optional(),
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        useWhen: z.string(),
        targetSlug: z.string(),
        targetMap: z.string().optional(),
      }),
    )
    .optional(),
  after: z.string().optional(),
  version: z.number().int().nonnegative(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const parsed = NewCard.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const { version, ...input } = parsed.data;
  try {
    const res = await putRecallCard(
      user.id,
      id,
      null,
      input,
      {
        kind: 'owner',
        id: user.actor.id,
        name: user.actor.displayName ?? null,
      },
      version,
    );
    return NextResponse.json(res, { status: 201 });
  } catch (err) {
    return recallWriteFailure(err);
  }
}
