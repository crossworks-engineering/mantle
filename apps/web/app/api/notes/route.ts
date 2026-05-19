import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { createNote, listNotes } from '@/lib/notes';
import { recordIngest } from '@mantle/tracing';

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(500_000).optional().default(''),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

export async function GET(req: Request) {
  const user = await requireOwner();
  const url = new URL(req.url);
  const rows = await listNotes(user.id, {
    query: url.searchParams.get('q') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
  });
  return NextResponse.json({ notes: rows });
}

export async function POST(req: Request) {
  const user = await requireOwner();
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
