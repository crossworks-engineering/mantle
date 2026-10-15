import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { parseSearchQuery } from '@mantle/client-types/search-query';
import { resolveSupersededTargets, searchChunks, searchNodes } from '@mantle/search';
import { embed } from '@mantle/embeddings';
import { nodeUrl } from '@mantle/content';
import type { SearchChunkHit, SearchNodeHit } from '@mantle/client-types';
import { currentFirst, hitWorkspaces, parseReadCover } from '@/lib/list-workspaces';

/**
 * Owner-facing hybrid search — the HTTP twin of the `search_nodes` /
 * `search_chunks` MCP tools, added for the mobile companion. Same ranking:
 * the query is embedded (vector-led hybrid); a failed embed degrades node
 * search to FTS rather than erroring. `mode=chunks` is passage-level and
 * needs the embedding, so an embed failure there is a 503.
 *
 * It looks in every workspace the caller reads (the request scope's row
 * rules decide which items those are). `ws` (the switcher's workspace,
 * task f26a516e) narrows nothing: the hits it reads come first, every hit
 * names the workspace it opens in (`workspace`), and `ws` is echoed.
 */
export async function GET(req: Request) {
  const user = ownerCaller();

  const parsed = parseSearchQuery(new URL(req.url).searchParams);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { q, mode, type, branch, tags, limit } = parsed;
  const cover = await parseReadCover(req, user.id, user.actor.id, 'across');
  if (cover instanceof Response) return cover;
  const current = cover.current;
  const echo = current ? { ws: current } : {};

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
    const [chunkSuccessors, chunkHomes] = await Promise.all([
      resolveSupersededTargets(
        user.id,
        hits.filter((h) => h.nodeSupersededBy).map((h) => h.nodeId),
      ),
      hitWorkspaces(
        user.id,
        user.actor.id,
        hits.map((h) => h.nodeId),
        current,
      ),
    ]);
    const results = hits.map((h): SearchChunkHit => {
      const succ = chunkSuccessors.get(h.nodeId);
      const home = chunkHomes.get(h.nodeId);
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
        ...(home ? { workspace: home } : {}),
      };
    });
    return NextResponse.json({
      mode,
      results: currentFirst(results, (r) => r.workspace, current),
      ...echo,
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
  const [successors, homes] = await Promise.all([
    resolveSupersededTargets(
      user.id,
      rows.filter((r) => r.supersededBy).map((r) => r.id),
    ),
    hitWorkspaces(
      user.id,
      user.actor.id,
      rows.map((r) => r.id),
      current,
    ),
  ]);
  const results = rows.map((r): SearchNodeHit => {
    const succ = successors.get(r.id);
    const home = homes.get(r.id);
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
      ...(succ ? { supersededBy: { id: succ.id, title: succ.title, url: nodeUrl(succ.id) } } : {}),
      ...(home ? { workspace: home } : {}),
    };
  });
  return NextResponse.json({
    mode,
    results: currentFirst(results, (r) => r.workspace, current),
    ...echo,
  });
}
