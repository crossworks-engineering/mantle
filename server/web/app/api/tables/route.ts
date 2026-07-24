import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  countTables,
  createTable,
  listTableTags,
  listTables,
  tableToText,
  type TableSort,
} from '@/lib/tables';
import { recordIngest } from '@mantle/tracing';

const SORTS: TableSort[] = ['edited', 'newest', 'oldest', 'title'];
const PAGE_SIZE = 50;

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  data: z.record(z.string(), z.unknown()).optional(),
  icon: z.string().max(16).optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const query = url.searchParams.get('q') ?? undefined;
  const tag = url.searchParams.get('tag') ?? undefined;
  const sortParam = url.searchParams.get('sort');
  const sort: TableSort = SORTS.includes(sortParam as TableSort)
    ? (sortParam as TableSort)
    : 'edited';

  const [tables, total, tags] = await Promise.all([
    listTables(user.id, { query, tag, sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countTables(user.id, { query, tag }),
    listTableTags(user.id),
  ]);
  return NextResponse.json({ tables, total, page, pageSize: PAGE_SIZE, tags });
}

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
