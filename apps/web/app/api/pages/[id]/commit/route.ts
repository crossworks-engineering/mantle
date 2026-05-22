import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { commitPage, docToText } from '@/lib/pages';
import { recordIngest } from '@mantle/tracing';

const Body = z.object({ doc: z.record(z.unknown()) });

/**
 * Commit: publish the document and index it. This is the only moment a page
 * body reaches the brain (extractor → summary + embedding + facts), so it's
 * the natural place to open a content_ingest trace.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const page = await commitPage(user.id, id, parsed.data.doc);
  if (!page) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const snippet = docToText(page.doc);
  void recordIngest({
    source: 'page_commit',
    ownerId: user.id,
    nodeId: page.id,
    summary: `Page committed: ${page.title.slice(0, 80)}`,
    payload: { title: page.title, tags: page.tags, textChars: snippet.length, via: 'web_api' },
    snippet,
  });
  return NextResponse.json({ page });
}
