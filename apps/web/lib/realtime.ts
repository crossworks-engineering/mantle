import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { PENDING_CHANGED_CHANNEL } from '@mantle/tools';

/**
 * Realtime bridge (server-only). A single app-wide Postgres LISTENer on the
 * `node_ingested` channel — the trigger migration 0018 already fires on every
 * `nodes` insert — fanned out to in-process SSE subscribers. One dedicated DB
 * connection serves every connected browser tab, regardless of how many.
 *
 * Each notify carries only the node id; we look up its type + owner once and
 * broadcast a typed change so the SSE route can filter per owner + interest.
 * Imported only by /api/realtime.
 */

export type RealtimeChange = { ownerId: string; type: string; id: string };
type Subscriber = (c: RealtimeChange) => void;

type Bridge = {
  subs: Set<Subscriber>;
  starting: Promise<void> | null;
  stop: (() => Promise<void>) | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __mantleRealtime: Bridge | undefined;
}

// Survive Next.js dev HMR (module re-eval) so we never stack up listeners.
const bridge: Bridge =
  globalThis.__mantleRealtime ?? { subs: new Set<Subscriber>(), starting: null, stop: null };
globalThis.__mantleRealtime = bridge;

async function ensureListening(): Promise<void> {
  if (bridge.stop) return;
  if (bridge.starting) return bridge.starting;
  bridge.starting = (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL must be set');
    // Dedicated single connection — a LISTEN monopolises its connection, so
    // keep it off the shared query pool.
    const sql = postgres(url, { max: 1, prepare: false });
    // Two channels: `node_ingested` (a row was inserted — the file/note/event
    // appears) and `node_indexed` (the extractor finished — summary + embedding
    // landed). Both fan out the same typed change; the second is what makes a
    // freshly-summarised file repaint without a manual refresh.
    const subIngested = await sql.listen('node_ingested', (nodeId) => {
      void fanout(nodeId);
    });
    const subIndexed = await sql.listen('node_indexed', (nodeId) => {
      void fanout(nodeId);
    });
    // Approval queue changes (a tool call queued / approved / rejected).
    // Unlike node_* the payload IS the owner id, not a node id — so we
    // broadcast directly without a nodes lookup. Drives the live sidebar
    // pending-approval badge + /pending repaint.
    const subPending = await sql.listen(PENDING_CHANGED_CHANNEL, (ownerId) => {
      broadcast({ ownerId, type: 'pending_tool_call', id: '' });
    });
    bridge.stop = async () => {
      try {
        await subIngested.unlisten();
        await subIndexed.unlisten();
        await subPending.unlisten();
      } catch {
        /* ignore */
      }
      await sql.end({ timeout: 5 });
      bridge.stop = null;
    };
  })();
  try {
    await bridge.starting;
  } finally {
    bridge.starting = null;
  }
}

/** Push a fully-formed change to every subscriber. One bad subscriber
 *  must not break the rest. */
function broadcast(change: RealtimeChange): void {
  for (const cb of bridge.subs) {
    try {
      cb(change);
    } catch {
      /* one bad subscriber shouldn't break the rest */
    }
  }
}

async function fanout(nodeId: string): Promise<void> {
  if (bridge.subs.size === 0) return;
  try {
    const [n] = await db
      .select({ type: nodes.type, ownerId: nodes.ownerId })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!n) return;
    broadcast({ ownerId: n.ownerId, type: n.type as string, id: nodeId });
  } catch {
    /* lookup failure — drop this notify rather than crash the listener */
  }
}

/** Subscribe to node changes. Lazily starts the shared listener on first use.
 *  Returns an unsubscribe fn. */
export async function subscribeRealtime(cb: Subscriber): Promise<() => void> {
  bridge.subs.add(cb);
  try {
    await ensureListening();
  } catch (err) {
    console.error('[realtime] listener start failed:', err);
  }
  return () => {
    bridge.subs.delete(cb);
  };
}
