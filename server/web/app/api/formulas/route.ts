import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { parseWsFilter } from '@/lib/list-workspaces';
import { countFormulas, createFormula, listFormulas, listFormulaStandards } from '@/lib/formulas';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
  POST: {
    class: 'content',
    open: 'owner',
    creates: true,
    item: { none: 'creates an item: ?ws= names where it lands' },
  },
});

const PAGE_SIZE = 50;

const CreateBody = z.object({
  // A spec is always an object; `z.unknown()` would make the key optional in
  // the inferred type, which is exactly what it must not be here.
  spec: z.record(z.string(), z.unknown()),
  title: z.string().max(200).optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

export async function GET(req: Request) {
  const user = ownerCaller();
  // `?ws=<id>` keeps only what that workspace reads (as the notes and apps
  // lists do), echoed as `ws`; a workspace the login cannot see is 404.
  const ws = await parseWsFilter(req, user.id, user.actor.id);
  if (ws instanceof Response) return ws;
  const inWs = ws ? { ws } : {};
  const url = new URL(req.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const opts = {
    query: url.searchParams.get('q') ?? undefined,
    standard: url.searchParams.get('standard') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
    ...inWs,
  };
  const [formulas, total, standards] = await Promise.all([
    listFormulas(user.id, { ...opts, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countFormulas(user.id, opts),
    // Unfiltered, so the filter control keeps every option regardless of what
    // is currently selected.
    // The standards facet is brain-wide by design (names only, from what the
    // caller reads), so ?ws= does not narrow it.
    listFormulaStandards(user.id),
  ]);
  return NextResponse.json({ formulas, total, page, pageSize: PAGE_SIZE, standards, ...inWs });
}

export async function POST(req: Request) {
  const user = ownerCaller();
  const raw = await readJson(req);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const row = await createFormula(user.id, parsed.data);
  return NextResponse.json(row, { status: 201 });
}
