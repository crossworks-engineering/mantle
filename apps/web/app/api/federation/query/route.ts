import { NextResponse } from 'next/server';
import { z } from 'zod';
import { queryForPeer } from '@mantle/content';
import { startTrace, step } from '@mantle/tracing';
import { authenticatePeer } from '@/lib/federation-auth';

/**
 * Inbound federation query — a peer Mantle asking what we hold for it.
 * Bearer-authed (per-peer token); returns ONLY nodes with an active grant
 * (queryForPeer has no unscoped path). Every call opens a `federation_request`
 * trace under the answering owner, so cross-Mantle reads show on /traces.
 */
const QueryBody = z.object({
  query: z.string().max(500).optional(),
  types: z.array(z.string().max(40)).max(20).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export async function POST(req: Request) {
  const peer = await authenticatePeer(req);
  if (!peer) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const raw = await req.json().catch(() => ({}));
  const parsed = QueryBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }

  const hits = await startTrace(
    {
      kind: 'federation_request',
      ownerId: peer.ownerId,
      subjectId: peer.id,
      subjectKind: 'mantle_peer',
      data: {
        surface: 'federation',
        op: 'query',
        peer: peer.displayName,
        query: parsed.data.query ?? '',
        types: parsed.data.types ?? [],
      },
    },
    async () =>
      step({ name: 'query_for_peer', kind: 'db_read', input: parsed.data }, async (h) => {
        const rows = await queryForPeer(peer.id, parsed.data);
        h.setMeta({ result_count: rows.length });
        return rows;
      }),
  );

  return NextResponse.json({ nodes: hits, count: hits.length });
}
