import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { countJournals, createJournal, listJournalTags, listJournals } from '@/lib/journal';
import { recordIngest } from '@mantle/tracing';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';

const PAGE_SIZE = 50;

const CreateBody = z.object({
  body: z.string().max(20_000),
  title: z.string().max(200).optional(),
  kind: z.string().max(40).optional(),
  entryDate: z.string().max(40).optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

export async function GET(req: Request) {
  const user = ownerCaller();
  const url = new URL(req.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const authorRaw = url.searchParams.get('author');
  const author: 'user' | 'agent' | undefined =
    authorRaw === 'user' || authorRaw === 'agent' ? authorRaw : undefined;
  const laneRaw = url.searchParams.get('lane');
  const lane: 'user' | 'agent' | undefined =
    laneRaw === 'user' || laneRaw === 'agent' ? laneRaw : undefined;
  const opts = {
    query: url.searchParams.get('q') ?? undefined,
    kind: url.searchParams.get('kind') ?? undefined,
    lane,
    author,
    status: url.searchParams.get('status') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
    learnedBy: url.searchParams.get('learned_by')?.slice(0, 80) || undefined,
  };
  const [journals, total, tags] = await Promise.all([
    listJournals(user.id, { ...opts, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countJournals(user.id, opts),
    listJournalTags(user.id),
  ]);
  return NextResponse.json({ journals, total, page, pageSize: PAGE_SIZE, tags });
}

export async function POST(req: Request) {
  const user = ownerCaller();
  const raw = await readJson(req);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  if (!parsed.data.body.trim()) {
    return NextResponse.json({ error: 'body is required' }, { status: 400 });
  }
  // Web session = the user's own hand; provenance is stamped server-side.
  const row = await createJournal(user.id, { ...parsed.data, author: 'user' });
  void recordIngest({
    source: 'journal_create',
    ownerId: user.id,
    nodeId: row.id,
    summary: `Journal entry created: ${row.title.slice(0, 80)}`,
    payload: {
      title: row.title,
      kind: row.kind,
      tags: row.tags,
      bodyChars: parsed.data.body.length,
      via: 'web_api',
    },
    snippet: parsed.data.body,
  });
  return NextResponse.json({ journal: row }, { status: 201 });
}
