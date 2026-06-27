import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { commitTable, tableToText } from '@/lib/tables';
import type { TableDoc } from '@mantle/content/table-model';
import { recordIngest } from '@mantle/tracing';

const Body = z.object({ data: z.record(z.unknown()) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const table = await commitTable(user.id, id, parsed.data.data as TableDoc);
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
