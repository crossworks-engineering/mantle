import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { queryForPeer } from '@mantle/content';
import { embed } from '@mantle/embeddings';
import { startTrace, step } from '@mantle/tracing';
import { authenticatePeer } from '@/lib/federation-auth';

/**
 * Inbound federation query — a peer Mantle asking what we hold for it.
 * Bearer-authed (per-peer token); returns ONLY nodes with an active grant
 * (queryForPeer has no unscoped path). Every call opens a `federation_request`
 * trace under the answering owner, so cross-Mantle reads show on /traces.
 *
 * Ranking is semantic: the wire carries text only, and WE embed the query in
 * this owner's vector space (grants were embedded with the same config) before
 * running the hybrid pipeline. Embed failure degrades to FTS — same policy as
 * the local search tool — so a peer query never fails because the embedder is
 * down. Wire format is unchanged; older peers just get better-ranked results.
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
    async () => {
      let queryEmbedding: number[] | undefined;
      const q = parsed.data.query?.trim();
      if (q) {
        try {
          queryEmbedding = await embed(peer.ownerId, q);
        } catch {
          // Degrade to FTS ranking rather than failing the peer's request.
        }
      }
      return step({ name: 'query_for_peer', kind: 'db_read', input: parsed.data }, async (h) => {
        const rows = await queryForPeer(peer.id, { ...parsed.data, queryEmbedding });
        h.setMeta({ result_count: rows.length, semantic: Boolean(queryEmbedding) });
        return rows;
      });
    },
  );

  return NextResponse.json({ nodes: hits, count: hits.length });
}
