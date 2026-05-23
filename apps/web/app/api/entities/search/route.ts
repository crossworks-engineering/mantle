import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { searchEntities } from '@mantle/search';

/**
 * Read-only entity lookup for the editor's @-mention autocomplete. Resolves a
 * query against the owner's existing entities (exact + trigram). Pure read —
 * never creates entities; new names typed in a page are created by the
 * extractor on commit, as for any other content.
 */
export async function GET(req: Request) {
  const user = await requireOwner();
  const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
  if (!q) return NextResponse.json({ entities: [] });
  const hits = await searchEntities({ ownerId: user.id, q, limit: 8 });
  return NextResponse.json({
    entities: hits.map((e) => ({ id: e.id, label: e.name, kind: e.kind })),
  });
}
