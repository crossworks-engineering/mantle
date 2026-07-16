import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { PENDING_CHANGED_CHANNEL } from '@mantle/tools';
import { TURN_STREAM_CHANNEL, type TurnStreamEnvelope } from '@mantle/turn-stream';
import type { TurnEvent } from '@mantle/client-types';

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

/** A conversation turn landed (any channel). Drives the mobile companion's
 *  live chat (/api/assistant/stream). Payload comes from the
 *  `conversation_changed` NOTIFY (migration 0091). */
export const CONVERSATION_CHANGED_CHANNEL = 'conversation_changed';
export type ConversationChange = {
  ownerId: string;
  agentSlug: string;
  direction: 'inbound' | 'outbound';
};
type ConvSubscriber = (c: ConversationChange) => void;

/** A live turn event landed (status / tool / reasoning / token delta) — drives
 *  the live "what the agent is doing" UI. Payload is a `TurnStreamEnvelope` from
 *  the `turn_stream` NOTIFY (`publishTurnEvent` in @mantle/turn-stream); the
 *  owner id is used to filter per subscriber and never reaches the browser. */
type TurnStreamSubscriber = (env: TurnStreamEnvelope) => void;

type Bridge = {
  subs: Set<Subscriber>;
  convSubs: Set<ConvSubscriber>;
  turnSubs: Set<TurnStreamSubscriber>;
  starting: Promise<void> | null;
  stop: (() => Promise<void>) | null;
};

declare global {
  var __mantleRealtime: Bridge | undefined;
}

// Survive Next.js dev HMR (module re-eval) so we never stack up listeners.
const bridge: Bridge = globalThis.__mantleRealtime ?? {
  subs: new Set<Subscriber>(),
  convSubs: new Set<ConvSubscriber>(),
  turnSubs: new Set<TurnStreamSubscriber>(),
  starting: null,
  stop: null,
};
// A bridge persisted from before a field existed (dev HMR re-eval) won't have
// it — backfill so subscribe* can't hit `undefined`.
bridge.convSubs ??= new Set<ConvSubscriber>();
bridge.turnSubs ??= new Set<TurnStreamSubscriber>();
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
    // Conversation turns (any channel) — payload is JSON {ownerId, agentId,
    // direction}, broadcast to the chat-stream subscribers. Drives live chat.
    const subConversation = await sql.listen(CONVERSATION_CHANGED_CHANNEL, (payload) => {
      try {
        const c = JSON.parse(payload) as ConversationChange;
        if (c && c.ownerId && c.agentSlug) broadcastConversation(c);
      } catch {
        /* malformed payload — drop it rather than crash the listener */
      }
    });
    // Live turn events (status / tool / token deltas) — payload is a JSON
    // {ownerId, event} envelope; broadcast to the per-(owner,turn) subscribers.
    const subTurnStream = await sql.listen(TURN_STREAM_CHANNEL, (payload) => {
      try {
        const env = JSON.parse(payload) as TurnStreamEnvelope;
        if (env && env.ownerId && env.event && typeof env.event.turnId === 'string') {
          broadcastTurnStream(env);
        }
      } catch {
        /* malformed payload — drop it rather than crash the listener */
      }
    });
    bridge.stop = async () => {
      try {
        await subIngested.unlisten();
        await subIndexed.unlisten();
        await subPending.unlisten();
        await subConversation.unlisten();
        await subTurnStream.unlisten();
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

/** Push a conversation change to every chat-stream subscriber. */
function broadcastConversation(change: ConversationChange): void {
  for (const cb of bridge.convSubs) {
    try {
      cb(change);
    } catch {
      /* one bad subscriber shouldn't break the rest */
    }
  }
}

/** Push a turn-stream envelope to every turn subscriber (each one self-filters
 *  by owner + turn). One bad subscriber must not break the rest. */
function broadcastTurnStream(env: TurnStreamEnvelope): void {
  for (const cb of bridge.turnSubs) {
    try {
      cb(env);
    } catch {
      /* one bad subscriber shouldn't break the rest */
    }
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

/** Subscribe to conversation turns (live chat). Shares the one LISTEN
 *  connection with subscribeRealtime; returns an unsubscribe fn. */
export async function subscribeConversations(cb: ConvSubscriber): Promise<() => void> {
  bridge.convSubs.add(cb);
  try {
    await ensureListening();
  } catch (err) {
    console.error('[realtime] listener start failed:', err);
  }
  return () => {
    bridge.convSubs.delete(cb);
  };
}

/**
 * Subscribe to live turn events for ONE (owner, turn). The owner filter is the
 * cross-tenant isolation boundary: a caller only ever receives events whose
 * envelope owner matches the authenticated session, so a `turnId` guessed from
 * another owner yields nothing. The callback receives the bare `TurnEvent` (the
 * envelope's owner id is stripped). Shares the one LISTEN connection; returns an
 * unsubscribe fn. */
export async function subscribeTurnStream(
  ownerId: string,
  turnId: string,
  cb: (event: TurnEvent) => void,
): Promise<() => void> {
  const wrapped: TurnStreamSubscriber = (env) => {
    if (env.ownerId !== ownerId) return;
    if (env.event.turnId !== turnId) return;
    cb(env.event);
  };
  bridge.turnSubs.add(wrapped);
  try {
    await ensureListening();
  } catch (err) {
    console.error('[realtime] listener start failed:', err);
  }
  return () => {
    bridge.turnSubs.delete(wrapped);
  };
}
