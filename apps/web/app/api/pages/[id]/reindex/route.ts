import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { reindexPage } from '@/lib/pages';

/**
 * Re-index a page: invalidate its cached summary/embedding and fire the
 * extractor against the latest persisted document. The editor calls this when
 * editing settles, so frequent autosaves (PATCH with reindex:false) stay cheap.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const ok = await reindexPage(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
