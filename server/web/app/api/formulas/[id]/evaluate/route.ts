import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { evaluateSpec, readFormulaSpec, type FormulaValue } from '@/lib/formulas';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';

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
  const user = ownerCaller();
  const { id } = await ctx.params;
  const raw = await readJson(req);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  // Not there (FormulaNotFoundError) answers 404, a stored spec that no longer
  // validates (FormulaSpecError) 400 with its list, by the one table (A10
  // part 2).
  const spec = await readFormulaSpec(user.id, id);
  const result = evaluateSpec(
    spec,
    parsed.data.target,
    parsed.data.inputs as Record<string, FormulaValue>,
  );
  return NextResponse.json(result);
}
