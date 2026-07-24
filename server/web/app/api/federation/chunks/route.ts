import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { searchChunksForPeer } from '@mantle/content';
import { embed } from '@mantle/embeddings';
import { startTrace, step } from '@mantle/tracing';
import { authenticatePeer } from '@/lib/federation-auth';

/**
 * Inbound federation PASSAGE search — a peer asking for the most relevant
 * sections inside the nodes we granted it. Bearer-authed; results are strictly
 * a subset of the peer's active grants (searchChunksForPeer has no unscoped
 * path). Pure vector search: we embed the peer's query text in this owner's
 * vector space; if the embedder is unavailable there is nothing to rank by, so
 * we return 503 (the caller's tool suggests peer_query as the fallback).
 * Endpoint is additive — older peers simply never call it.
 */
const ChunksBody = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).optional(),
});

export async function POST(req: Request) {
  const peer = await authenticatePeer(req);
  if (!peer) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const raw = await req.json().catch(() => ({}));
  const parsed = ChunksBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }

  let embedding: number[];
  try {
    embedding = await embed(peer.ownerId, parsed.data.query.trim());
  } catch {
    return NextResponse.json({ error: 'embedding unavailable' }, { status: 503 });
  }

  const chunks = await startTrace(
    {
      kind: 'federation_request',
      ownerId: peer.ownerId,
      subjectId: peer.id,
      subjectKind: 'mantle_peer',
      data: {
        surface: 'federation',
        op: 'chunks',
        peer: peer.displayName,
        query: parsed.data.query,
      },
    },
    async () =>
      step({ name: 'search_chunks_for_peer', kind: 'db_read', input: parsed.data }, async (h) => {
        const rows = await searchChunksForPeer(peer.id, embedding, parsed.data.limit ?? 10);
        h.setMeta({ result_count: rows.length });
        return rows;
      }),
  );

  return NextResponse.json({ chunks, count: chunks.length });
}
