import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import {
  checkLookupCoverage,
  deleteFormula,
  getFormula,
  updateFormula,
  parseFormulaSpec,
  checkDimensions,
  signatureOf,
} from '@/lib/formulas';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

const PatchBody = z.object({
  spec: z.record(z.string(), z.unknown()).optional(),
  title: z.string().max(200).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
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
    // The evaluator form and the public share calculator both build their
    // fields from this rather than each re-deriving which symbols are needed.
    signature: parsed.ok ? signatureOf(parsed.spec) : [],
    ...(parsed.ok ? {} : { specErrors: parsed.errors }),
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const raw = await readJson(req);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const row = await updateFormula(user.id, id, parsed.data);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // Safe unguarded: updateFormula validated the spec on the way in.
  return NextResponse.json({
    formula: row,
    coverageGaps: checkLookupCoverage(row.spec),
    dimensionIssues: checkDimensions(row.spec),
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const done = await deleteFormula(user.id, id);
  if (!done) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
