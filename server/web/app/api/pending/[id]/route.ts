import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { approvePendingCall, getPendingCall, rejectPendingCall } from '@mantle/tools';
import { ASK_HUMAN_FORM_LIMITS as L } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';

const IdParams = z.object({ id: z.string().uuid() });
const PatchBody = z.object({
  decision: z.enum(['approve', 'reject']),
  /** Runner ask_human questions: the free-text answer the run continues
   *  with (approve only; optional — plain approval works for yes/no). */
  answer: z.string().max(4000).optional(),
  /** Structured questionnaire answers — one entry per form question. Caps come
   *  from the SHARED contract, so the route can't drift from the parser that
   *  authored the form or the renderer that displayed it. */
  answers: z
    .array(
      z.object({
        question: z.string().min(1).max(200),
        selected: z.array(z.string().max(L.maxLabelChars)).max(L.maxOptions),
        other: z.string().max(L.maxOtherChars).optional(),
      }),
    )
    .max(L.maxQuestions)
    .optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const row = await getPendingCall(user.id, idParsed.data.id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ pending: row });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    // Name the field that ACTUALLY failed. A blanket "expected { decision }"
    // sent an over-long `other` or a fifth answer chasing the wrong problem.
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : 'body';
    return NextResponse.json(
      {
        error: `${where}: ${issue?.message ?? 'invalid'} (expected { decision: approve|reject, answer?, answers? })`,
      },
      { status: 400 },
    );
  }
  try {
    const { answer, answers } = parsed.data;
    const row =
      parsed.data.decision === 'approve'
        ? await approvePendingCall(
            user.id,
            idParsed.data.id,
            answer || answers?.length
              ? { ...(answer ? { answer } : {}), ...(answers?.length ? { answers } : {}) }
              : undefined,
          )
        : await rejectPendingCall(user.id, idParsed.data.id);
    if (!row) {
      return NextResponse.json(
        { error: 'pending call not found or already decided' },
        { status: 404 },
      );
    }
    return NextResponse.json({ pending: row });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
