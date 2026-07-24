import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { parseSearchQuery } from '@mantle/web-ui/search-query';
import { resolveSupersededTargets, searchChunks, searchNodes } from '@mantle/search';
import { embed } from '@mantle/embeddings';
import { nodeUrl } from '@mantle/content';

/**
 * Owner-facing hybrid search — the HTTP twin of the `search_nodes` /
 * `search_chunks` MCP tools, added for the mobile companion. Same ranking:
 * the query is embedded (vector-led hybrid); a failed embed degrades node
 * search to FTS rather than erroring. `mode=chunks` is passage-level and
 * needs the embedding, so an embed failure there is a 503.
 */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const parsed = parseSearchQuery(new URL(req.url).searchParams);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { q, mode, type, branch, tags, limit } = parsed;

  let queryEmbedding: number[] | undefined;
  try {
    queryEmbedding = await embed(user.id, q);
  } catch (err) {
    console.error('[api/search] query embed failed, falling back to FTS:', err);
  }

  if (mode === 'chunks') {
    if (!queryEmbedding) {
      return NextResponse.json(
        { error: 'passage search unavailable (query embedding failed)' },
        { status: 503 },
      );
    }
    const hits = await searchChunks({
      ownerId: user.id,
      embedding: queryEmbedding,
      q,
      branch,
      limit,
    });
    // Same content-currency annotation as nodes mode (and the MCP twin):
    // a stale passage still surfaces, but carries its living successor.
    const chunkSuccessors = await resolveSupersededTargets(
      user.id,
      hits.filter((h) => h.nodeSupersededBy).map((h) => h.nodeId),
    );
    return NextResponse.json({
      mode,
      results: hits.map((h) => {
        const succ = chunkSuccessors.get(h.nodeId);
        return {
          nodeId: h.nodeId,
          nodeTitle: h.nodeTitle,
          nodeType: h.nodeType,
          ordinal: h.ordinal,
          heading: h.headingPath,
          text: h.text,
          url: nodeUrl(h.nodeId),
          ...(succ
            ? { supersededBy: { id: succ.id, title: succ.title, url: nodeUrl(succ.id) } }
            : {}),
        };
      }),
    });
  }

  const rows = await searchNodes({
    ownerId: user.id,
    q,
    branch,
    type,
    tags,
    limit,
    queryEmbedding,
  });
  const successors = await resolveSupersededTargets(
    user.id,
    rows.filter((r) => r.supersededBy).map((r) => r.id),
  );
  return NextResponse.json({
    mode,
    results: rows.map((r) => {
      const succ = successors.get(r.id);
      const data = r.data as Record<string, unknown> | null;
      return {
        id: r.id,
        type: r.type,
        title: r.title,
        path: r.path,
        tags: r.tags,
        summary: typeof data?.summary === 'string' ? data.summary : null,
        updatedAt: r.updatedAt.toISOString(),
        url: nodeUrl(r.id),
        ...(succ
          ? { supersededBy: { id: succ.id, title: succ.title, url: nodeUrl(succ.id) } }
          : {}),
      };
    }),
  });
}
