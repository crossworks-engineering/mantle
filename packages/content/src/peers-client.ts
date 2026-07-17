/**
 * Federation OUTBOUND client — the half that calls a peer's federation API.
 * Kept separate from peers.ts (the DB layer) because this is the only place in
 * @mantle/content that does network I/O. Shared by the `peer_*` builtins
 * (Saskia) and the MCP server tools (Claude Desktop/Code) so the resolve +
 * sign + fetch logic lives in exactly one place.
 *
 * Every call signs with the peer's sealed outbound token (decrypted via
 * getOutboundToken) and targets the peer's `base_url`. We only ever receive
 * what the peer granted us — the scoping is enforced on their side.
 */
import { getOutboundToken, listPeers, markPeerContacted, type PeerRow } from './peers';

const FETCH_TIMEOUT_MS = 15_000;

export type PeerClientResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Resolve a peer by id or display name (case-insensitive), enabled+active. */
async function resolvePeer(ownerId: string, ref: string): Promise<PeerRow | { error: string }> {
  const peers = await listPeers(ownerId);
  if (peers.length === 0) return { error: 'No peers are configured. Add one at /settings/peers.' };
  const trimmed = ref.trim();
  const byId = peers.find((p) => p.id === trimmed);
  const cand = byId
    ? [byId]
    : peers.filter((p) => p.displayName.toLowerCase() === trimmed.toLowerCase());
  if (cand.length === 0)
    return { error: `No peer matches "${ref}". Use peer_list to see configured peers.` };
  if (cand.length > 1)
    return { error: `Multiple peers named "${ref}". Use the peer id (see peer_list).` };
  const p = cand[0]!;
  if (p.enabled && p.status === 'pending') {
    return {
      error: `Pairing with "${p.displayName}" is half-done — they haven't given you their token yet. Paste it under Tokens at /settings/peers to enable queries.`,
    };
  }
  if (!p.enabled || p.status !== 'active') {
    return { error: `Peer "${p.displayName}" is ${p.enabled ? p.status : 'disabled'}.` };
  }
  return p;
}

async function callPeer(
  peer: PeerRow,
  token: string,
  path: string,
  init: { method: string; body?: unknown },
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${peer.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json as { error?: string })?.error ?? `HTTP ${res.status}`;
      return { ok: false, error: `${peer.displayName} returned ${res.status}: ${msg}` };
    }
    return { ok: true, json };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not reach ${peer.displayName} (${peer.baseUrl}): ${m}` };
  } finally {
    clearTimeout(timer);
  }
}

async function withToken(
  ownerId: string,
  ref: string,
): Promise<{ peer: PeerRow; token: string } | { error: string }> {
  const resolved = await resolvePeer(ownerId, ref);
  if ('error' in resolved) return resolved;
  const token = await getOutboundToken(ownerId, resolved.id);
  if (!token) return { error: `No outbound token stored for "${resolved.displayName}".` };
  return { peer: resolved, token };
}

export type PeerQueryResult = {
  peer: string;
  nodes: Array<Record<string, unknown>>;
  count: number;
};

/** Ask a peer for nodes it has shared with us, matching the query/filters. */
export async function queryPeer(
  ownerId: string,
  ref: string,
  opts: { query?: string; types?: string[]; limit?: number } = {},
): Promise<PeerClientResult<PeerQueryResult>> {
  const r = await withToken(ownerId, ref);
  if ('error' in r) return { ok: false, error: r.error };
  const res = await callPeer(r.peer, r.token, '/api/federation/query', {
    method: 'POST',
    body: { query: opts.query, types: opts.types, limit: opts.limit },
  });
  if (!res.ok) return { ok: false, error: res.error };
  await markPeerContacted(ownerId, r.peer.id);
  const out = res.json as { nodes?: Array<Record<string, unknown>>; count?: number };
  return {
    ok: true,
    data: {
      peer: r.peer.displayName,
      nodes: out.nodes ?? [],
      count: out.count ?? out.nodes?.length ?? 0,
    },
  };
}

export type PeerChunkSearchResult = {
  peer: string;
  chunks: Array<Record<string, unknown>>;
  count: number;
};

/**
 * Ask a peer for the most relevant PASSAGES inside its granted nodes (semantic
 * chunk search — the peer embeds the query in its own vector space). Peers on
 * pre-chunks Mantle versions return 404; surface that as a friendly hint.
 */
export async function searchPeerChunks(
  ownerId: string,
  ref: string,
  opts: { query: string; limit?: number },
): Promise<PeerClientResult<PeerChunkSearchResult>> {
  const r = await withToken(ownerId, ref);
  if ('error' in r) return { ok: false, error: r.error };
  const res = await callPeer(r.peer, r.token, '/api/federation/chunks', {
    method: 'POST',
    body: { query: opts.query, limit: opts.limit },
  });
  if (!res.ok) {
    const notSupported = /returned 404/.test(res.error);
    return {
      ok: false,
      error: notSupported
        ? `${r.peer.displayName} does not support passage search yet (older Mantle version) — use peer_query instead.`
        : res.error,
    };
  }
  await markPeerContacted(ownerId, r.peer.id);
  const out = res.json as { chunks?: Array<Record<string, unknown>>; count?: number };
  return {
    ok: true,
    data: {
      peer: r.peer.displayName,
      chunks: out.chunks ?? [],
      count: out.count ?? out.chunks?.length ?? 0,
    },
  };
}

/** Fetch one granted node's full content from a peer. */
export async function getPeerNode(
  ownerId: string,
  ref: string,
  nodeId: string,
): Promise<PeerClientResult<{ peer: string; node: unknown }>> {
  const r = await withToken(ownerId, ref);
  if ('error' in r) return { ok: false, error: r.error };
  const res = await callPeer(
    r.peer,
    r.token,
    `/api/federation/node/${encodeURIComponent(nodeId)}`,
    {
      method: 'GET',
    },
  );
  if (!res.ok) return { ok: false, error: res.error };
  await markPeerContacted(ownerId, r.peer.id);
  const out = res.json as { node?: unknown };
  return { ok: true, data: { peer: r.peer.displayName, node: out.node ?? null } };
}
