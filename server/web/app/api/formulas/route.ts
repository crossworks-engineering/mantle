import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { countFormulas, createFormula, listFormulas, isFormulaSpecError } from '@/lib/formulas';

const PAGE_SIZE = 50;

const CreateBody = z.object({
  // A spec is always an object; `z.unknown()` would make the key optional in
  // the inferred type, which is exactly what it must not be here.
  spec: z.record(z.string(), z.unknown()),
  title: z.string().max(200).optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const opts = {
    query: url.searchParams.get('q') ?? undefined,
    standard: url.searchParams.get('standard') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
  };
  const [formulas, total] = await Promise.all([
    listFormulas(user.id, { ...opts, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countFormulas(user.id, opts),
  ]);
  return NextResponse.json({ formulas, total, page, pageSize: PAGE_SIZE });
}

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    const row = await createFormula(user.id, parsed.data);
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    // Spec validation reports every problem at once; surface the whole list so
    // the editor can show them together rather than one-at-a-time.
    if (isFormulaSpecError(err)) {
      return NextResponse.json({ error: err.message, errors: err.errors }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'invalid input' },
      { status: 400 },
    );
  }
}
