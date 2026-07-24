import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { countNotes, createNote, isDigestTag, listNoteTags, listNotes } from '@/lib/notes';
import { recordIngest } from '@mantle/tracing';

const PAGE_SIZE = 50;

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(500_000).optional().default(''),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

/**
 * The /notes list — paginated + filtered, with tag facets, matching the old
 * server page. Agent digests are hidden unless `?digests=1` (or the tag is
 * itself a digest tag like `agent:assistant`).
 */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const sp = new URL(req.url).searchParams;
  const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1);
  const query = sp.get('q')?.trim() || undefined;
  const tag = sp.get('tag')?.trim() || undefined;
  const includeDigests = sp.get('digests') === '1' || (!!tag && isDigestTag(tag));

  const [notes, total, tags] = await Promise.all([
    listNotes(user.id, {
      query,
      tag,
      includeDigests,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countNotes(user.id, { query, tag, includeDigests }),
    listNoteTags(user.id, { includeDigests }),
  ]);
  return NextResponse.json({ notes, total, page, pageSize: PAGE_SIZE, tags });
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
  const row = await createNote(user.id, parsed.data);
  void recordIngest({
    source: 'note_create',
    ownerId: user.id,
    nodeId: row.id,
    summary: `Note created: ${row.title.slice(0, 80)}`,
    payload: {
      title: row.title,
      tags: row.tags,
      contentChars: parsed.data.content?.length ?? 0,
      via: 'web_api',
    },
    snippet: parsed.data.content,
  });
  return NextResponse.json({ note: row }, { status: 201 });
}
