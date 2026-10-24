import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { and, db, desc, eq, ilike, not, inArray, nodes, sql } from '@mantle/db';
import { PEER_PICK_EXCLUDED_KINDS } from '@mantle/client-types/kind-lists';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'connectors' },
});

/**
 * Node picker for the peer-grant UI: title search across grantable node types.
 * Excludes structural/sensitive types — branches (folders), peer records
 * themselves, and secrets (their content is sealed; share deliberately by
 * another route if ever needed, not via a casual picker). The kind registry's
 * `peerPick` field (A10 #12).
 */
const EXCLUDED = PEER_PICK_EXCLUDED_KINDS;

export async function GET(req: Request) {
  const user = ownerCaller();
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
