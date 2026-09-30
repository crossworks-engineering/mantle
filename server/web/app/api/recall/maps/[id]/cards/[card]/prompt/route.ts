import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { confirmRecallPrompt } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { recallWriteFailure } from '@/lib/recall';
import { firstIssue } from '@/lib/zod-issue';
import { UUID_RE } from '@mantle/std';

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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id, card } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  try {
    const res = await confirmRecallPrompt(
      user.id,
      id,
      card,
      parsed.data.confirm,
      { kind: 'owner', id: user.actor.id, name: user.actor.displayName ?? null },
      parsed.data.version,
    );
    return NextResponse.json(res);
  } catch (err) {
    return recallWriteFailure(err);
  }
}
