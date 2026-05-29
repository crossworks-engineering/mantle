/**
 * Federation peer tools — Saskia's OUTBOUND half. Where the federation HTTP
 * API (apps/web/app/api/federation) lets another Mantle read FROM us, these
 * let us read FROM a peer. The resolve + sign + fetch logic lives in
 * @mantle/content's peers-client (shared with the MCP server); these are thin
 * wrappers that surface it as agent tools. Saskia only ever sees what the peer
 * granted us — the scoping is enforced on their side. See docs/federation.md.
 */
import { getPeerNode, listPeers, queryPeer } from '@mantle/content';
import type { BuiltinToolDef, ToolHandlerResult } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function numOpt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s): s is string => typeof s === 'string');
  return out.length > 0 ? out : undefined;
}

const peer_list: BuiltinToolDef = {
  slug: 'peer_list',
  name: 'List federated peers',
  description:
    "List the federated Mantle peers configured for this account — other people's Mantle systems you can query for data they've shared with you. Returns each peer's id, name, base URL, and status. Use before peer_query if you're unsure of the exact peer name.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx): Promise<ToolHandlerResult> => {
    try {
      const peers = await listPeers(ctx.ownerId);
      const rows = peers.map((p) => ({
        id: p.id,
        name: p.displayName,
        baseUrl: p.baseUrl,
        status: p.status,
        enabled: p.enabled,
      }));
      ctx.step?.setMeta({ count: rows.length });
      return { ok: true, output: { peers: rows, count: rows.length } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const peer_query: BuiltinToolDef = {
  slug: 'peer_query',
  name: 'Query a federated peer',
  description:
    "Ask another Mantle (a federated peer) for data it has shared with you. `peer` is the peer's name or id (see peer_list). `query` is free-text matched against the titles/summaries of nodes the peer GRANTED you — you only ever see what they chose to share, never their whole brain. Optionally narrow by `types` (e.g. ['file','note']). Returns matching node summaries; use peer_node_get to pull one node's full content. Example: peer_query(peer='Her Mantle', query='passport').",
  inputSchema: {
    type: 'object',
    properties: {
      peer: { type: 'string', description: "The peer's name or id (see peer_list)." },
      query: { type: 'string', description: 'Free-text search over shared node titles/summaries.' },
      types: {
        type: 'array',
        items: { type: 'string' },
        description: "Optional node-type filter, e.g. ['file','note','contact'].",
      },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['peer'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const ref = str(input.peer).trim();
    if (!ref) return { ok: false, error: 'peer required' };
    const res = await queryPeer(ctx.ownerId, ref, {
      query: strOpt(input.query),
      types: strArr(input.types),
      limit: numOpt(input.limit),
    });
    if (!res.ok) return { ok: false, error: res.error };
    ctx.step?.setMeta({ peer: res.data.peer, count: res.data.count });
    return { ok: true, output: res.data };
  },
};

const peer_node_get: BuiltinToolDef = {
  slug: 'peer_node_get',
  name: 'Get a node from a federated peer',
  description:
    "Fetch one shared node's full content from a peer. `peer` is the peer's name or id; `nodeId` is an id returned by peer_query. Fails if the peer hasn't granted you that node. Use after peer_query to read the details of a specific result.",
  inputSchema: {
    type: 'object',
    properties: {
      peer: { type: 'string', description: "The peer's name or id." },
      nodeId: { type: 'string', description: 'A node id from peer_query results.' },
    },
    required: ['peer', 'nodeId'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const ref = str(input.peer).trim();
    const nodeId = str(input.nodeId).trim();
    if (!ref || !nodeId) return { ok: false, error: 'peer + nodeId required' };
    const res = await getPeerNode(ctx.ownerId, ref, nodeId);
    if (!res.ok) return { ok: false, error: res.error };
    ctx.step?.setMeta({ peer: res.data.peer, nodeId });
    return { ok: true, output: res.data };
  },
};

export const PEER_TOOLS: readonly BuiltinToolDef[] = [peer_list, peer_query, peer_node_get];
