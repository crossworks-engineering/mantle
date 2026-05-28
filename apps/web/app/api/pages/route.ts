import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { createPage, docToText, listPages, ParentPageNotFoundError } from '@/lib/pages';
import { recordIngest } from '@mantle/tracing';

/** A ProseMirror/TipTap document — an opaque object the editor owns. We only
 *  validate that it's an object here; `docToText` flattens it for the brain. */
const DocSchema = z.record(z.unknown());

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  doc: DocSchema.optional(),
  icon: z.string().max(16).optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
  /** Optional parent page id — nests the new page as a sub-page (Phase 4a). */
  parentId: z.string().uuid().optional(),
});

export async function GET(req: Request) {
  const user = await requireOwner();
  const url = new URL(req.url);
  const rows = await listPages(user.id, {
    query: url.searchParams.get('q') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
  });
  return NextResponse.json({ pages: rows });
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
  let row;
  try {
    row = await createPage(user.id, parsed.data);
  } catch (err) {
    if (err instanceof ParentPageNotFoundError) {
      return NextResponse.json({ error: 'parent page not found' }, { status: 400 });
    }
    throw err;
  }
  const snippet = docToText(row.doc);
  void recordIngest({
    source: 'page_create',
    ownerId: user.id,
    nodeId: row.id,
    summary: `Page created: ${row.title.slice(0, 80)}`,
    payload: {
      title: row.title,
      tags: row.tags,
      textChars: snippet.length,
      via: 'web_api',
    },
    snippet,
  });
  return NextResponse.json({ page: row }, { status: 201 });
}
