import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { db, nodes, runAsSystem, systemDatabaseUrl } from '@mantle/db';
import {
  APP_NAV_CHANGED_CHANNEL,
  NEEDS_YOU_CHANGED_CHANNEL,
  NEEDS_YOU_REALTIME_TYPE,
  TASKS_CHANGED_CHANNEL,
} from '@mantle/content';
import { TREE_CHANGED_CHANNEL } from '@mantle/content/tree';
import { messengerParticipantLogins } from '@mantle/content/messenger';
import { log } from '@mantle/tracing';
import { PENDING_CHANGED_CHANNEL } from '@mantle/tools';
import { RUNS_CHANGED_CHANNEL, RUNS_CHANGED_TYPE } from '@mantle/runs';
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
  /** Row status (migration 0156): a streamed turn notifies once 'pending' and
   *  once 'complete' | 'failed'. Absent from the pre-0156 payload. */
  status?: 'pending' | 'complete' | 'failed';
  /** The login whose thread changed (0269, W7c): a stream tells each login
   *  about its own thread only. Absent from the pre-0269 payload. */
  loginId?: string | null;
};
type ConvSubscriber = (c: ConversationChange) => void;

/** A live turn event landed (status / tool / reasoning / token delta) — drives
 *  the live "what the agent is doing" UI. Payload is a `TurnStreamEnvelope` from
 *  the `turn_stream` NOTIFY (`publishTurnEvent` in @mantle/turn-stream); the
 *  owner id is used to filter per subscriber and never reaches the browser. */
type TurnStreamSubscriber = (env: TurnStreamEnvelope) => void;

/** A messenger change (Messenger V1, migration 0335): ids and seq, never
 *  text. Payload of the `messenger_changed` NOTIFY. */
export const MESSENGER_CHANGED_CHANNEL = 'messenger_changed';
export type MessengerChange = {
  c: string;
  seq: number | null;
  kind: 'new' | 'edit' | 'delete' | 'read' | 'self' | 'participants' | 'reaction' | 'typing';
  actor: string | null;
};
type MessengerSubscriber = (c: MessengerChange) => void;

type Bridge = {
  subs: Set<Subscriber>;
  convSubs: Set<ConvSubscriber>;
  turnSubs: Set<TurnStreamSubscriber>;
  /** Messenger streams by login id (each stream is one login's). */
  msgSubs: Map<string, Set<MessengerSubscriber>>;
  /** The fan-out map of plan section 7: conversation id to its participant
   *  logins (with the seq a left one reads up to), filled on first use and
   *  dropped on a participants event. A stale entry can at worst send an id
   *  to a login that then gets 404 on the fetch; never text. */
  msgRooms: Map<string, { loginId: string; leftSeq: number | null; fromSeq: number }[]>;
  /** Bumped on every drop of msgRooms (fanoutMessenger). */
  msgRoomsGen: number;
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
  msgSubs: new Map<string, Set<MessengerSubscriber>>(),
  msgRooms: new Map<string, { loginId: string; leftSeq: number | null; fromSeq: number }[]>(),
  msgRoomsGen: 0,
  starting: null,
  stop: null,
};
// A bridge persisted from before a field existed (dev HMR re-eval) won't have
// it — backfill so subscribe* can't hit `undefined`.
bridge.convSubs ??= new Set<ConvSubscriber>();
bridge.turnSubs ??= new Set<TurnStreamSubscriber>();
bridge.msgSubs ??= new Map<string, Set<MessengerSubscriber>>();
bridge.msgRooms ??= new Map<
  string,
  { loginId: string; leftSeq: number | null; fromSeq: number }[]
>();
bridge.msgRoomsGen ??= 0;
globalThis.__mantleRealtime = bridge;

async function ensureListening(): Promise<void> {
  if (bridge.stop) return;
  if (bridge.starting) return bridge.starting;
  bridge.starting = (async () => {
    // The app's own login (the runtime role with MANTLE_DB_RUNTIME_ROLE on).
    const url = systemDatabaseUrl();
    // Dedicated single connection — a LISTEN monopolises its connection, so
    // keep it off the shared query pool.
    const sql = postgres(url, { max: 1, prepare: false });
    // Two channels: `node_ingested` (a row was inserted — the file/note/event
    // appears) and `node_indexed` (the extractor finished — summary + embedding
    // landed). Both fan out the same typed change; the second is what makes a
    // freshly-summarised file repaint without a manual refresh.
    // Arch A2a: the lookup is the bridge's own work, never the login of the
    // request that happened to start the bridge.
    const subIngested = await sql.listen('node_ingested', (nodeId) => {
      void runAsSystem('listen:realtime', () => fanout(nodeId));
    });
    const subIndexed = await sql.listen('node_indexed', (nodeId) => {
      void runAsSystem('listen:realtime', () => fanout(nodeId));
    });
    // Approval queue changes (a tool call queued / approved / rejected).
    // Unlike node_* the payload IS the owner id, not a node id — so we
    // broadcast directly without a nodes lookup. Drives the live sidebar
    // pending-approval badge + /pending repaint.
    const subPending = await sql.listen(PENDING_CHANGED_CHANNEL, (ownerId) => {
      broadcast({ ownerId, type: 'pending_tool_call', id: '' });
    });
    // "Needs you" (migration 0186 triggers): a provider outage started or
    // cleared (0230; review and team requests went in W5c, their triggers
    // still fire). Owner-id payload, like pending_changed. It reaches admin
    // sessions only: /api/realtime is the owner stream (members are refused
    // there), and the member stream carries no events since W8d. The client
    // refetches /api/embedding (its provider alerts).
    const subNeedsYou = await sql.listen(NEEDS_YOU_CHANGED_CHANNEL, (ownerId) => {
      if (ownerId) broadcast({ ownerId, type: NEEDS_YOU_REALTIME_TYPE, id: '' });
    });
    // Runner-queue changes (a run created / an item changing state / a run
    // finishing). Same owner-id-as-payload shape as `pending_changed`; raised
    // by the migration-0135 triggers rather than by application code, so no
    // engine path can forget it. Drives the live /runs master-detail and the
    // active-runs strip.
    const subRuns = await sql.listen(RUNS_CHANGED_CHANNEL, (ownerId) => {
      broadcast({ ownerId, type: RUNS_CHANGED_TYPE, id: '' });
    });
    // Task mutations the node_ingested trigger misses: deletes and
    // rank/tags-only updates (migration 0148 — trigger, so no write path can
    // forget it). Owner-id payload; the client refetches its task list.
    const subTasks = await sql.listen(TASKS_CHANGED_CHANNEL, (ownerId) => {
      broadcast({ ownerId, type: 'task', id: '' });
    });
    // App-nav writes (layout, pins, app create/rename/recolour/delete) —
    // owner-id payload; the sidebar refetches /api/app-nav on every device.
    const subAppNav = await sql.listen(APP_NAV_CHANGED_CHANNEL, (ownerId) => {
      broadcast({ ownerId, type: 'app-nav', id: '' });
    });
    // Item-tree writes (folders created, renamed, moved, restyled, deleted;
    // items moved; pins). JSON {ownerId, kind} payload, broadcast typed 'tree'
    // with the kind as id so a client refetches that kind's open folders.
    const subTree = await sql.listen(TREE_CHANGED_CHANNEL, (payload) => {
      try {
        const c = JSON.parse(payload) as { ownerId?: string; kind?: string };
        if (c && c.ownerId && c.kind) broadcast({ ownerId: c.ownerId, type: 'tree', id: c.kind });
      } catch {
        /* malformed payload: drop it rather than crash the listener */
      }
    });
    // No comment events: the brain has no comments any more (2026-10-09).
    // The node_comments trigger may still NOTIFY on its channel; nobody
    // listens, so an older UI's comment views are never told to refetch.
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
    // Messenger changes (0335): fanned out to the streams of the logins
    // that are participants of the conversation (fanoutMessenger).
    const subMessenger = await sql.listen(MESSENGER_CHANGED_CHANNEL, (payload) => {
      try {
        const c = JSON.parse(payload) as MessengerChange;
        if (c && typeof c.c === 'string' && typeof c.kind === 'string') {
          void runAsSystem('listen:realtime', () => fanoutMessenger(c));
        }
      } catch {
        /* malformed payload: drop it rather than crash the listener */
      }
    });
    bridge.stop = async () => {
      try {
        await subMessenger.unlisten();
        await subIngested.unlisten();
        await subIndexed.unlisten();
        await subPending.unlisten();
        await subNeedsYou.unlisten();
        await subRuns.unlisten();
        await subTasks.unlisten();
        await subAppNav.unlisten();
        await subTree.unlisten();
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

const realtimeLog = log('realtime');

/** The cap of the fan-out map: past it the map starts again (each entry is
 *  one indexed read to refill). */
const MESSENGER_ROOMS_MAX = 5000;

/** Who hears a messenger change: a room event every live participant (and
 *  the actor); a message event every participant that may read its seq;
 *  'self' only the actor; 'typing' everyone live but the typist. */
async function fanoutMessenger(c: MessengerChange): Promise<void> {
  if (bridge.msgSubs.size === 0) return;
  if (c.kind === 'participants') {
    bridge.msgRooms.delete(c.c);
    bridge.msgRoomsGen += 1;
  }
  let to: string[];
  if (c.kind === 'self') {
    to = c.actor ? [c.actor] : [];
  } else {
    let rows = bridge.msgRooms.get(c.c);
    if (!rows) {
      // A participants event that lands during this lookup must not see its
      // drop undone by the older list: keep it only when no drop
      // happened meanwhile.
      const gen = bridge.msgRoomsGen;
      rows = await messengerParticipantLogins(c.c);
      if (gen === bridge.msgRoomsGen) {
        if (bridge.msgRooms.size >= MESSENGER_ROOMS_MAX) bridge.msgRooms.clear();
        bridge.msgRooms.set(c.c, rows);
      }
    }
    const seq = c.seq;
    const message = seq !== null && c.kind !== 'read' && c.kind !== 'typing';
    to = rows
      .filter((r) =>
        message
          ? seq > r.fromSeq && (r.leftSeq === null || r.leftSeq >= seq)
          : r.leftSeq === null || (seq !== null && c.kind !== 'typing' && r.leftSeq >= seq),
      )
      .map((r) => r.loginId);
    if (c.kind === 'typing') to = to.filter((l) => l !== c.actor);
    if (c.kind === 'participants' && c.actor && !to.includes(c.actor)) to.push(c.actor);
  }
  for (const loginId of to) {
    for (const cb of bridge.msgSubs.get(loginId) ?? []) {
      try {
        cb(c);
      } catch (err) {
        realtimeLog.error('messenger subscriber threw:', err);
      }
    }
  }
}

/**
 * Subscribe ONE login's stream to the messenger changes it may hear: only
 * those of conversations it is a participant of (the fan-out map). Shares
 * the one LISTEN connection; returns an unsubscribe fn.
 */
export async function subscribeMessenger(
  loginId: string,
  cb: MessengerSubscriber,
): Promise<() => void> {
  let set = bridge.msgSubs.get(loginId);
  if (!set) {
    set = new Set();
    bridge.msgSubs.set(loginId, set);
  }
  set.add(cb);
  try {
    await ensureListening();
  } catch (err) {
    realtimeLog.error('listener start failed:', err);
  }
  return () => {
    const s = bridge.msgSubs.get(loginId);
    s?.delete(cb);
    if (s && s.size === 0) bridge.msgSubs.delete(loginId);
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
