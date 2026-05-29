import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { and, db, desc, eq, ilike, not, inArray, nodes, sql } from '@mantle/db';

/**
 * Node picker for the peer-grant UI: title search across grantable node types.
 * Excludes structural/sensitive types — branches (folders), peer records
 * themselves, and secrets (their content is sealed; share deliberately by
 * another route if ever needed, not via a casual picker).
 */
const EXCLUDED = ['branch', 'mantle_peer', 'secret'] as const;

export async function GET(req: Request) {
  const user = await requireOwner();
  const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
  if (!q) return NextResponse.json({ nodes: [] });
  const rows = await db
    .select({ id: nodes.id, title: nodes.title, type: nodes.type })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, user.id),
        ilike(nodes.title, `%${q}%`),
        not(inArray(sql`${nodes.type}::text`, [...EXCLUDED])),
      ),
    )
    .orderBy(desc(nodes.updatedAt))
    .limit(10);
  return NextResponse.json({ nodes: rows });
}
