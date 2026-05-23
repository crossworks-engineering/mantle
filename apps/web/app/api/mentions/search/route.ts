import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { searchEntities } from '@mantle/search';
import { and, db, desc, eq, ilike, inArray, nodes } from '@mantle/db';

/**
 * Read-only resolver for the editor's @-mention picker. Returns two kinds of
 * reference, pages/notes first (you have those immediately) then entities
 * (which fill in as the brain learns):
 *   - ref:'node'   → another page/note to link to (→ `references` edge)
 *   - ref:'entity' → a person/project/place (→ `mentioned_in` edge)
 *
 * Pure read — never creates anything. Edges are built by the extractor on
 * commit from the resolved ids the chip carries.
 */
export async function GET(req: Request) {
  const user = await requireOwner();
  const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
  if (!q) return NextResponse.json({ items: [] });

  const [nodeRows, entities] = await Promise.all([
    db
      .select({ id: nodes.id, title: nodes.title, type: nodes.type })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, user.id),
          inArray(nodes.type, ['page', 'note']),
          ilike(nodes.title, `%${q}%`),
        ),
      )
      .orderBy(desc(nodes.updatedAt))
      .limit(6),
    searchEntities({ ownerId: user.id, q, limit: 6 }),
  ]);

  return NextResponse.json({
    items: [
      ...nodeRows.map((n) => ({ ref: 'node' as const, id: n.id, label: n.title, kind: n.type })),
      ...entities.map((e) => ({ ref: 'entity' as const, id: e.id, label: e.name, kind: e.kind })),
    ],
  });
}
