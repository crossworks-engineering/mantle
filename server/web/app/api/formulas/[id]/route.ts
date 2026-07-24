import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  checkLookupCoverage,
  deleteFormula,
  getFormula,
  updateFormula,
  isFormulaSpecError,
  parseFormulaSpec,
  checkDimensions,
} from '@/lib/formulas';

const PatchBody = z.object({
  spec: z.record(z.string(), z.unknown()).optional(),
  title: z.string().max(200).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const row = await getFormula(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // `row.spec` is a cast, not a re-parse (see rowOf), so a node whose data.spec
  // is absent or malformed — a restore, a hand-edit, a future writer — would
  // throw inside coverage and surface as an unhandled 500. Re-validate and
  // degrade to "no coverage information" instead.
  const parsed = parseFormulaSpec(row.spec);
  return NextResponse.json({
    formula: row,
    coverageGaps: parsed.ok ? checkLookupCoverage(parsed.spec) : [],
    dimensionIssues: parsed.ok ? checkDimensions(parsed.spec) : [],
    ...(parsed.ok ? {} : { specErrors: parsed.errors }),
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    const row = await updateFormula(user.id, id, parsed.data);
    if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
    // Safe unguarded: updateFormula validated the spec on the way in.
    return NextResponse.json({
      formula: row,
      coverageGaps: checkLookupCoverage(row.spec),
      dimensionIssues: checkDimensions(row.spec),
    });
  } catch (err) {
    if (isFormulaSpecError(err)) {
      return NextResponse.json({ error: err.message, errors: err.errors }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'invalid input' },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const done = await deleteFormula(user.id, id);
  if (!done) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
