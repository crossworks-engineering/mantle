import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { countLifelogs, createLifelog, listLifelogTags, listLifelogs } from '@/lib/lifelog';
import { recordIngest } from '@mantle/tracing';

const PAGE_SIZE = 50;

const CreateBody = z.object({
  body: z.string().max(20_000),
  title: z.string().max(200).optional(),
  mood: z.string().max(40).optional(),
  category: z.string().max(40).optional(),
  entryDate: z.string().max(40).optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const opts = {
    query: url.searchParams.get('q') ?? undefined,
    mood: url.searchParams.get('mood') ?? undefined,
    category: url.searchParams.get('category') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
  };
  const [lifelogs, total, tags] = await Promise.all([
    listLifelogs(user.id, { ...opts, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countLifelogs(user.id, opts),
    listLifelogTags(user.id),
  ]);
  return NextResponse.json({ lifelogs, total, page, pageSize: PAGE_SIZE, tags });
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
  if (!parsed.data.body.trim()) {
    return NextResponse.json({ error: 'body is required' }, { status: 400 });
  }
  let row;
  try {
    row = await createLifelog(user.id, parsed.data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'invalid input' },
      { status: 400 },
    );
  }
  void recordIngest({
    source: 'lifelog_create',
    ownerId: user.id,
    nodeId: row.id,
    summary: `Life log created: ${row.title.slice(0, 80)}`,
    payload: {
      title: row.title,
      mood: row.mood,
      category: row.category,
      tags: row.tags,
      bodyChars: parsed.data.body.length,
      via: 'web_api',
    },
    snippet: parsed.data.body,
  });
  return NextResponse.json({ lifelog: row }, { status: 201 });
}
