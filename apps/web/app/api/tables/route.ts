import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { createTable, listTables, tableToText } from '@/lib/tables';
import { recordIngest } from '@mantle/tracing';

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  data: z.record(z.unknown()).optional(),
  icon: z.string().max(16).optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

export async function GET(req: Request) {
  const user = await requireOwner();
  const url = new URL(req.url);
  const rows = await listTables(user.id, {
    query: url.searchParams.get('q') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
  });
  return NextResponse.json({ tables: rows });
}

export async function POST(req: Request) {
  const user = await requireOwner();
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const { data, ...rest } = parsed.data;
  const row = await createTable(user.id, { ...rest, ...(data ? { data: data as never } : {}) });
  const snippet = tableToText(row.data, { title: row.title });
  void recordIngest({
    source: 'table_create',
    ownerId: user.id,
    nodeId: row.id,
    summary: `Table created: ${row.title.slice(0, 80)}`,
    payload: { title: row.title, tags: row.tags, via: 'web_api' },
    snippet,
  });
  return NextResponse.json({ table: row }, { status: 201 });
}
