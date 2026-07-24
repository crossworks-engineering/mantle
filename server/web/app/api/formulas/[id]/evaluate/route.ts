import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { evaluateSpec, readFormulaSpec, type FormulaValue } from '@/lib/formulas';

const Body = z.object({
  target: z.string().min(1).max(200),
  inputs: z
    .record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()]))
    .optional()
    .default({}),
});

/**
 * Evaluate one target of a stored formula. A failed evaluation is a 200 with
 * `ok: false`, not an HTTP error: "missing required input 'Pgauge'" is a normal
 * result the panel renders inline, not a broken request.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  let spec;
  try {
    spec = await readFormulaSpec(user.id, id);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'not found' },
      { status: 404 },
    );
  }
  const result = evaluateSpec(
    spec,
    parsed.data.target,
    parsed.data.inputs as Record<string, FormulaValue>,
  );
  return NextResponse.json(result);
}
