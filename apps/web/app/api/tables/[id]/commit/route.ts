import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { commitTable, tableToText } from '@/lib/tables';
import type { TableDoc } from '@mantle/content/table-model';
import { recordIngest } from '@mantle/tracing';

// `data` is the LEGACY whole-doc shape (pre-P3 clients / small tables). The
// op-based client posts an empty body and the SERVER draft is promoted — the
// only commit shape that works past the materialize window, and the §4
// truncation-guard fix (a windowed doc committed whole would BE published
// truncation).
const Body = z.object({ data: z.record(z.unknown()).optional() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  let table;
  try {
    table = await commitTable(user.id, id, parsed.data.data as TableDoc | undefined);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'commit failed' }, { status: 400 });
  }
  if (!table) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const snippet = tableToText(table.data, { title: table.title });
  void recordIngest({
    source: 'table_commit',
    ownerId: user.id,
    nodeId: table.id,
    summary: `Table committed: ${table.title.slice(0, 80)}`,
    payload: { title: table.title, tags: table.tags, via: 'web_api' },
    snippet,
  });
  return NextResponse.json({ table });
}
