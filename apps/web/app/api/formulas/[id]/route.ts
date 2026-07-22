import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  checkLookupCoverage,
  deleteFormula,
  getFormula,
  updateFormula,
  isFormulaSpecError,
} from '@/lib/formulas';

const PatchBody = z.object({
  spec: z.record(z.unknown()).optional(),
  title: z.string().max(200).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const row = await getFormula(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // Coverage is cheap and always worth showing — a gap in a source table is
  // exactly the thing a reader needs to see before trusting a number.
  return NextResponse.json({ formula: row, coverageGaps: checkLookupCoverage(row.spec) });
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
    return NextResponse.json({ formula: row, coverageGaps: checkLookupCoverage(row.spec) });
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
