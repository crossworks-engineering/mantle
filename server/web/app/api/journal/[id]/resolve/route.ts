import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { resolveGapEntry } from '@/lib/journal';
import { firstIssue } from '@/lib/zod-issue';

const ResolveBody = z.object({
  answer: z.string().max(20_000),
  answerKind: z.string().max(40).optional(),
});

/** Close one open question (a kind='gap' journal entry) with the user's
 *  answer. The gap is marked resolved and the answer lands as a new user-lane
 *  journal entry — the same two-write resolution the `journal_resolve_gap`
 *  tool performs from chat. 404 when the id isn't an owner-held gap entry. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const raw = await req.json().catch(() => ({}));
  const parsed = ResolveBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  if (!parsed.data.answer.trim()) {
    return NextResponse.json({ error: 'answer is required' }, { status: 400 });
  }
  let result;
  try {
    result = await resolveGapEntry(user.id, id, {
      answer: parsed.data.answer,
      answerKind: parsed.data.answerKind,
      author: 'user',
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'invalid input' },
      { status: 400 },
    );
  }
  if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ gap: result.gap, answer: result.answer });
}
