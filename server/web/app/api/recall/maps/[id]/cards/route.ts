import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import {
  RECALL_LABEL_MAX,
  RECALL_LINE_MAX,
  RECALL_OPTIONS_MAX,
  RECALL_TITLE_MAX,
  putRecallCard,
} from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { recallActorOf, recallWriteFailure } from '@/lib/recall';
import { UUID_RE } from '@mantle/std';
import { readBody } from '@/lib/read-body';

/** Add a card. The slug comes from the title; `after` places it. Replacing an
 *  existing card is PUT on the card itself. */
const NewCard = z.object({
  title: z.string().min(1).max(RECALL_TITLE_MAX),
  bodyMd: z.string(),
  useWhen: z.string().max(RECALL_LINE_MAX).optional(),
  prompt: z.boolean().optional(),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(RECALL_LABEL_MAX),
        useWhen: z.string().max(RECALL_LINE_MAX),
        targetSlug: z.string(),
        targetMap: z.string().optional(),
      }),
    )
    .max(RECALL_OPTIONS_MAX)
    .optional(),
  after: z.string().optional(),
  version: z.number().int().nonnegative(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = await readBody(req, NewCard);
  const { version, ...input } = body;
  try {
    const res = await putRecallCard(user.id, id, null, input, await recallActorOf(user), version);
    return NextResponse.json(res, { status: 201 });
  } catch (err) {
    return recallWriteFailure(err);
  }
}
