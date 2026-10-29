/**
 * Calls between people: a call is a LiveKit room named after the conversation. One
 * function per action, each one transaction on the system pool, as the
 * messenger's own writes (messenger.ts), whose participant rule, seq and
 * system lines a call takes.
 *
 *  - A call starts or is joined by a live participant's tap (startOrJoinCall):
 *    one open call per conversation (a partial unique index), the first tap
 *    opens the row and writes the "call started" line at the next seq, so
 *    the existing messenger_changed trigger carries it to every client; a
 *    later tap joins. The route answers a one-hour token for the one room,
 *    with the ICE override of section 20.
 *  - A login is in one call at a time across its devices: a second device
 *    swaps the first (the earlier participant is removed by identity), and
 *    a join to another chat's call drops it from the one it was in.
 *  - LiveKit says what happened through signed webhooks (applyCallWebhook:
 *    stays, the room's end); the reconciler (reconcileCalls, the events
 *    worker, every minute) is the truth when a webhook is lost, closes a
 *    row past MANTLE_CALLS_MAX_MINUTES and everything when the service is
 *    off. A call row is never left open.
 *  - A group admin ends a call or removes a person; in a direct chat either
 *    person may end it (a direct chat has no admin). Nobody holds an admin
 *    grant in a token: admin acts go through the room API here.
 *  - Agents in a call are P2: addCallAgent refuses and records nothing.
 *  - Cost safety (section 12): nothing here runs on a cron or a trigger;
 *    the reconciler closes, it never starts. No LLM work anywhere.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  db,
  messengerCallParticipants,
  messengerCalls,
  messengerCallWebhooks,
  systemDb,
} from '@mantle/db';
import { InputError, defineDomainError, isUuid } from '@mantle/std';
import { log } from '@mantle/tracing';
import {
  CALLS_MAX_MINUTES,
  CALLS_MAX_PARTICIPANTS,
  CALL_ROOM_EMPTY_TIMEOUT_S,
  callIceServers,
  callsAgentOn,
  callsServiceOn,
  identityAgentId,
  identityLoginId,
  livekitClient,
  livekitPublicUrl,
  loginIdentity,
  mintCallToken,
  type LivekitClient,
  type LivekitWebhook,
  LivekitUnavailableError,
} from './livekit';
import {
  appendMessage,
  lockConversation,
  lockForActor,
  loginNames,
  messengerChatAgents,
  MessengerNotFoundError,
  MessengerRefusedError,
  num,
  q,
  requireGroupAdmin,
  takeBudget,
  type ConversationRow,
  type MessengerActor,
  type Tx,
} from './messenger';

export const CALL_DEVICE_MAX = 32;
/** The webhook replay guard keeps an event id this long. */
const WEBHOOK_KEEP_MS = 24 * 60 * 60 * 1000;

// ── Errors ───────────────────────────────────────────────────────────────────

/** Calls are off on this brain (the Settings > Services switch): the one
 *  clear line, 404 (section 13). */
export class MessengerCallsOffError extends Error {
  constructor(message = 'Calls are not switched on for this brain.') {
    super(message);
    this.name = 'MessengerCallsOffError';
  }
}
defineDomainError(MessengerCallsOffError, {
  reason: 'calls are switched off on this brain (Settings > Services)',
  status: 404,
});

/** The call holds MANTLE_CALLS_MAX_PARTICIPANTS people already. */
export class MessengerCallFullError extends Error {
  constructor(max: number) {
    super(`This call is full (${max} people).`);
    this.name = 'MessengerCallFullError';
  }
}
defineDomainError(MessengerCallFullError, {
  reason: 'the call holds the box limit of people already',
  status: 409,
});

/** What P2 brings: an agent in a call. Refused, nothing recorded. */
export class MessengerCallsNotYetError extends Error {
  constructor(message = 'Agents in calls are not in P1.') {
    super(message);
    this.name = 'MessengerCallsNotYetError';
  }
}
defineDomainError(MessengerCallsNotYetError, {
  reason: 'agents in calls come with P2; the route refuses and records nothing',
  status: 501,
});

defineDomainError(LivekitUnavailableError, {
  reason: 'LiveKit did not answer (down, or the keys refused); nothing was recorded',
  status: 503,
});

// ── Views ────────────────────────────────────────────────────────────────────

export type MessengerCallIce = { urls: string[]; username: string; credential: string };

/** What a start, join or refresh answers (section 9 with the amendment of
 *  section 20). `callId` is null for a call with your own assistant (no
 *  messenger_calls row: assistant threads are not messenger rows). */
export type MessengerCallJoinView = {
  callId: string | null;
  room: string;
  url: string;
  token: string;
  expiresAt: string;
  ice: MessengerCallIce | null;
};

export type MessengerCallParticipantView = {
  kind: 'login' | 'agent';
  id: string;
  joinedAt: string;
  leftAt: string | null;
  device: string | null;
};

export type MessengerCallView = {
  id: string;
  conversationId: string;
  kind: 'audio' | 'video';
  startedBy: string | null;
  startedSeq: number;
  startedAt: string;
  endedAt: string | null;
  endedReason: 'finished' | 'cap_reached' | 'closed_by_admin' | 'service_off' | 'reconciled' | null;
  durationS: number | null;
  maxParticipants: number;
  participants: MessengerCallParticipantView[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

type CallRow = {
  id: string;
  conversation_id: string;
  room_name: string;
  kind: 'audio' | 'video';
  started_by: string | null;
  started_seq: string | number;
  started_at: Date;
  ended_at: Date | null;
  ended_reason: MessengerCallView['endedReason'];
  duration_s: number | null;
  max_participants: number;
  agent_id: string | null;
};

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export function callRoomName(conversationId: string): string {
  return `msgr-${conversationId.toLowerCase()}`;
}

export function assistantRoomName(agentId: string, loginId: string): string {
  return `asst-${agentId.toLowerCase()}-${loginId.toLowerCase()}`;
}

function deviceOr(v: string | null | undefined): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > CALL_DEVICE_MAX) {
    throw new InputError(`device must be at most ${CALL_DEVICE_MAX} characters.`);
  }
  return v;
}

/** The open call of a conversation, locked, or null. */
async function lockOpenCall(tx: Tx, conversationId: string): Promise<CallRow | null> {
  const [row] = await q<CallRow>(
    tx,
    sql`select id::text as id, conversation_id::text as conversation_id, room_name, kind,
               started_by::text as started_by, started_seq, started_at, ended_at, ended_reason,
               duration_s, max_participants, agent_id::text as agent_id
          from messenger_calls
         where conversation_id = ${conversationId}::uuid and ended_at is null
         for update`,
  );
  return row ?? null;
}

/** The conversation of a room's open call, read without a lock (the
 *  webhook and the reconciler start here), or null. */
async function openCallConversation(on: Tx, roomName: string): Promise<string | null> {
  const [row] = await q<{ conversation_id: string }>(
    on,
    sql`select conversation_id::text as conversation_id from messenger_calls
         where room_name = ${roomName} and ended_at is null`,
  );
  return row?.conversation_id ?? null;
}

/**
 * The one lock order, everywhere: the conversation row first, then its
 * open call row (the routes take it through lockForActor then
 * lockOpenCall). The webhook and the reconciler know only the room: they
 * read the conversation id unlocked, lock the conversation, then the call,
 * and re-check the call is still open and still that room's. Null when it
 * is not (closed meanwhile, or a chat that is gone).
 */
async function lockConversationAndCall(
  tx: Tx,
  roomName: string,
): Promise<{ conv: ConversationRow; call: CallRow } | null> {
  const conversationId = await openCallConversation(tx, roomName);
  if (!conversationId) return null;
  const conv = await lockConversation(tx, conversationId);
  if (!conv) return null;
  const call = await lockOpenCall(tx, conv.id);
  if (!call || call.room_name !== roomName) return null;
  return { conv, call };
}

async function openStayCount(tx: Tx, callId: string): Promise<number> {
  const [row] = await q<{ n: string | number }>(
    tx,
    sql`select count(*) as n from messenger_call_participants
         where call_id = ${callId}::uuid and left_at is null`,
  );
  return num(row?.n ?? 0);
}

/** The head count a closed call reports: distinct logins and agents that
 *  were ever in it. */
async function headCount(tx: Tx, callId: string): Promise<number> {
  const [row] = await q<{ n: string | number }>(
    tx,
    sql`select count(distinct coalesce(login_id, agent_id)) as n
          from messenger_call_participants where call_id = ${callId}::uuid`,
  );
  return num(row?.n ?? 0);
}

/** Mark a stay over (idempotent: an open stay of that identity in that
 *  call, if any). Returns whether one was open. */
async function closeStay(
  tx: Tx,
  callId: string,
  who: { loginId: string } | { agentId: string },
): Promise<boolean> {
  const where =
    'loginId' in who
      ? and(
          eq(messengerCallParticipants.loginId, who.loginId),
          eq(messengerCallParticipants.kind, 'login'),
        )
      : and(
          eq(messengerCallParticipants.agentId, who.agentId),
          eq(messengerCallParticipants.kind, 'agent'),
        );
  const rows = await tx
    .update(messengerCallParticipants)
    .set({ leftAt: sql`now()` })
    .where(
      and(
        eq(messengerCallParticipants.callId, callId),
        isNull(messengerCallParticipants.leftAt),
        where,
      ),
    )
    .returning({ id: messengerCallParticipants.id });
  return rows.length > 0;
}

/** Open a stay unless one is open already (idempotent for a replayed or
 *  reconciled join). Bumps the call's head-count high-water mark. */
async function openStay(
  tx: Tx,
  call: CallRow,
  who: { loginId: string } | { agentId: string },
  device: string | null,
): Promise<void> {
  const where =
    'loginId' in who
      ? and(
          eq(messengerCallParticipants.loginId, who.loginId),
          eq(messengerCallParticipants.kind, 'login'),
        )
      : and(
          eq(messengerCallParticipants.agentId, who.agentId),
          eq(messengerCallParticipants.kind, 'agent'),
        );
  const [open] = await tx
    .select({ id: messengerCallParticipants.id })
    .from(messengerCallParticipants)
    .where(
      and(
        eq(messengerCallParticipants.callId, call.id),
        isNull(messengerCallParticipants.leftAt),
        where,
      ),
    )
    .limit(1);
  if (open) {
    // A second device of the same login (section 5, "Join"): the one open
    // stay, now from the new device.
    if (device) {
      await tx
        .update(messengerCallParticipants)
        .set({ device })
        .where(eq(messengerCallParticipants.id, open.id));
    }
    return;
  }
  await tx.insert(messengerCallParticipants).values({
    callId: call.id,
    kind: 'loginId' in who ? 'login' : 'agent',
    loginId: 'loginId' in who ? who.loginId : null,
    agentId: 'agentId' in who ? who.agentId : null,
    device,
  });
  const n = await openStayCount(tx, call.id);
  if (n > call.max_participants) {
    await tx
      .update(messengerCalls)
      .set({ maxParticipants: n })
      .where(eq(messengerCalls.id, call.id));
    call.max_participants = n;
  }
}

/** Close a call: the row, its open stays, and the "call ended" line at the
 *  next seq (the trigger carries it). `conv` is locked by the caller. */
async function closeCall(
  tx: Tx,
  conv: ConversationRow,
  call: CallRow,
  reason: NonNullable<MessengerCallView['endedReason']>,
  byName: string | null = null,
): Promise<void> {
  const [t] = await q<{ seconds: string | number }>(
    tx,
    sql`select greatest(0, floor(extract(epoch from (now() - ${call.started_at})))) as seconds`,
  );
  const seconds = num(t?.seconds ?? 0);
  await tx
    .update(messengerCallParticipants)
    .set({ leftAt: sql`now()` })
    .where(
      and(eq(messengerCallParticipants.callId, call.id), isNull(messengerCallParticipants.leftAt)),
    );
  const participants = Math.max(await headCount(tx, call.id), call.max_participants);
  await tx
    .update(messengerCalls)
    .set({
      endedAt: sql`now()`,
      endedReason: reason,
      durationS: seconds,
      maxParticipants: participants,
    })
    .where(and(eq(messengerCalls.id, call.id), isNull(messengerCalls.endedAt)));
  const minutes = Math.max(1, Math.round(seconds / 60));
  const body =
    reason === 'cap_reached'
      ? `Call ended: the ${CALLS_MAX_MINUTES()}-minute limit was reached.`
      : reason === 'closed_by_admin'
        ? `${byName ?? 'An admin'} ended the call.`
        : reason === 'service_off'
          ? 'Call ended: calls were switched off on this brain.'
          : `Call ended (${minutes} min, ${participants} ${participants === 1 ? 'person' : 'people'}).`;
  await appendMessage(tx, conv, {
    authorKind: 'system',
    authorLoginId: null,
    authorName: null,
    via: null,
    body,
    mentions: [],
    replyToSeq: null,
    clientMsgId: null,
    event: {
      type: reason === 'cap_reached' ? 'call_cap' : 'call_ended',
      callId: call.id,
      seconds,
      participants,
    },
  });
}

/** The other open calls this login has an open stay in (one call at a time
 *  across chats): their stays closed here, their rooms told after commit. */
async function leaveOtherCalls(tx: Tx, loginId: string, exceptCallId: string): Promise<string[]> {
  const rows = await q<{ id: string; room_name: string }>(
    tx,
    sql`select k.id::text as id, k.room_name
          from messenger_calls k
          join messenger_call_participants p on p.call_id = k.id
         where k.ended_at is null and k.id <> ${exceptCallId}::uuid
           and p.kind = 'login' and p.login_id = ${loginId}::uuid and p.left_at is null`,
  );
  // No lock on the other calls' rows (the one lock order is conversation
  // then call, and this transaction holds another conversation): the stay
  // UPDATE locks only the stay rows, which is enough.
  for (const r of rows) await closeStay(tx, r.id, { loginId });
  return rows.map((r) => r.room_name);
}

async function joinView(
  callId: string | null,
  room: string,
  identity: string,
  name: string,
  turnPassword: string | null,
): Promise<MessengerCallJoinView> {
  const url = livekitPublicUrl();
  if (!url)
    throw new MessengerCallsOffError('Calls are not configured on this brain (no calls host).');
  const { token, expiresAt } = await mintCallToken({ identity, name, room });
  return { callId, room, url, token, expiresAt, ice: callIceServers(room, turnPassword) };
}

// ── Start or join ────────────────────────────────────────────────────────────

export type MessengerCallStartInput = { device?: string | null };

/**
 * POST /api/messenger/c/:id/call: start the call of a conversation, or join
 * the open one. A live participant only (a leaver is refused, an outsider
 * hears "not found"); calls must be on; the call must have room. The first
 * tap opens the row and writes the "call started" line; every tap answers
 * a token for this login, after the earlier device of the same login (and
 * any other call it was in) is dropped from its room.
 */
export async function startOrJoinCall(
  actor: MessengerActor,
  conversationId: string,
  input: MessengerCallStartInput = {},
): Promise<MessengerCallJoinView> {
  takeBudget(actor, 'write');
  if (!callsServiceOn()) throw new MessengerCallsOffError();
  const device = deviceOr(input.device);
  const room = callRoomName(conversationId);
  // The participant rule first, in a transaction of its own: no room is
  // made for a login that is not in the chat.
  await systemDb.transaction(async (tx) => {
    await lockForActor(tx, actor, conversationId);
  });
  // The room, before the row: a LiveKit that does not answer refuses the
  // tap with nothing written (the network call never holds the lock).
  const lk = livekitClient();
  const info = await lk.ensureRoom(room, {
    emptyTimeoutS: CALL_ROOM_EMPTY_TIMEOUT_S,
    maxParticipants: CALLS_MAX_PARTICIPANTS(),
  });
  const out = await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    void me;
    const names = await loginNames([actor.loginId], tx);
    const name = names.get(actor.loginId) ?? 'Someone';
    let call = await lockOpenCall(tx, conv.id);
    if (call) {
      const max = CALLS_MAX_PARTICIPANTS();
      const [mine] = await q<{ ok: number }>(
        tx,
        sql`select 1 as ok from messenger_call_participants
             where call_id = ${call.id}::uuid and kind = 'login'
               and login_id = ${actor.loginId}::uuid and left_at is null`,
      );
      if (!mine && (await openStayCount(tx, call.id)) >= max) throw new MessengerCallFullError(max);
    } else {
      const id = randomUUID();
      const seq = await appendMessage(tx, conv, {
        authorKind: 'system',
        authorLoginId: null,
        authorName: null,
        via: null,
        body: `${name} started a call.`,
        mentions: [],
        replyToSeq: null,
        clientMsgId: null,
        event: { type: 'call_started', callId: id },
      });
      await tx.insert(messengerCalls).values({
        id,
        conversationId: conv.id,
        roomName: room,
        kind: 'audio',
        startedBy: actor.loginId,
        startedSeq: seq,
      });
      call = (await lockOpenCall(tx, conv.id))!;
    }
    // The stay opens with the tap (the webhook's own join is idempotent on
    // it; the reconciler closes it if the client never connects), so the
    // chat knows who is in the call at once, from which device.
    await openStay(tx, call, { loginId: actor.loginId }, device);
    const otherRooms = await leaveOtherCalls(tx, actor.loginId, call.id);
    return { callId: call.id, name, otherRooms };
  });
  const identity = loginIdentity(actor.loginId);
  // The earlier device of this login, and the other call it was in: dropped
  // by identity before the new token is handed out (section 5, "Join").
  await lk.removeParticipant(room, identity).catch(() => {});
  for (const r of out.otherRooms) await lk.removeParticipant(r, identity).catch(() => {});
  return joinView(out.callId, room, identity, out.name, info.turnPassword);
}

/** POST /api/messenger/c/:id/call/token: a fresh hour for the live call;
 *  the same checks, no device swap. */
export async function refreshCallToken(
  actor: MessengerActor,
  conversationId: string,
): Promise<MessengerCallJoinView> {
  takeBudget(actor, 'write');
  if (!callsServiceOn()) throw new MessengerCallsOffError();
  const out = await systemDb.transaction(async (tx) => {
    const { conv } = await lockForActor(tx, actor, conversationId);
    const call = await lockOpenCall(tx, conv.id);
    if (!call) throw new MessengerNotFoundError('No call is open in this chat.');
    const names = await loginNames([actor.loginId], tx);
    return { call, name: names.get(actor.loginId) ?? 'Someone' };
  });
  const info = await livekitClient().getRoom(out.call.room_name);
  if (!info) throw new MessengerNotFoundError('The call has ended.');
  return joinView(
    out.call.id,
    out.call.room_name,
    loginIdentity(actor.loginId),
    out.name,
    info.turnPassword,
  );
}

/** POST /api/messenger/c/:id/call/leave: a courtesy (the webhook is the
 *  truth): my open stay is marked over and the room drops my identity. */
export async function leaveCall(actor: MessengerActor, conversationId: string): Promise<void> {
  takeBudget(actor, 'write');
  const out = await systemDb.transaction(async (tx) => {
    const { conv } = await lockForActor(tx, actor, conversationId, { live: false });
    const call = await lockOpenCall(tx, conv.id);
    if (!call) return null;
    await closeStay(tx, call.id, { loginId: actor.loginId });
    return call.room_name;
  });
  if (out && callsServiceOn()) {
    await livekitClient()
      .removeParticipant(out, loginIdentity(actor.loginId))
      .catch(() => {});
  }
}

/** POST /api/messenger/c/:id/call/end: a group admin ends the call for
 *  everyone (closed_by_admin); in a direct chat either person may. */
export async function endCall(actor: MessengerActor, conversationId: string): Promise<void> {
  takeBudget(actor, 'write');
  // The rule first; then the room is closed (everyone dropped); only then
  // the row. A LiveKit that does not answer refuses the end with nothing
  // written: a row closed while the room lived would never be closed again.
  const checked = await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    if (conv.kind === 'group') requireGroupAdmin(conv, me);
    const call = await lockOpenCall(tx, conv.id);
    if (!call) throw new MessengerNotFoundError('No call is open in this chat.');
    return { id: call.id, room: call.room_name };
  });
  if (callsServiceOn()) await livekitClient().deleteRoom(checked.room);
  await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    if (conv.kind === 'group') requireGroupAdmin(conv, me);
    const call = await lockOpenCall(tx, conv.id);
    // The call checked above, and only that one: a call that closed and
    // another that opened meanwhile are not this admin's end.
    if (!call || call.id !== checked.id) return;
    const names = await loginNames([actor.loginId], tx);
    await closeCall(tx, conv, call, 'closed_by_admin', names.get(actor.loginId) ?? 'Someone');
  });
}

/** DELETE /api/messenger/c/:id/call/participants/:loginId: a group admin
 *  drops a person from the call (the room drops the identity; the stay is
 *  marked over). */
export async function removeCallParticipant(
  actor: MessengerActor,
  conversationId: string,
  loginId: string,
): Promise<void> {
  takeBudget(actor, 'write');
  if (!isUuid(loginId)) throw new InputError('The login id must be a uuid.');
  const target = loginId.toLowerCase();
  const out = await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    requireGroupAdmin(conv, me);
    const call = await lockOpenCall(tx, conv.id);
    if (!call) throw new MessengerNotFoundError('No call is open in this chat.');
    await closeStay(tx, call.id, { loginId: target });
    return call.room_name;
  });
  if (callsServiceOn()) {
    await livekitClient()
      .removeParticipant(out, loginIdentity(target))
      .catch(() => {});
  }
}

/** POST and DELETE /api/messenger/c/:id/call/agent: P2. Refuses with one
 *  line and records nothing (the participant rule is still checked, so an
 *  outsider hears "not found" as everywhere). */
export async function addCallAgent(
  actor: MessengerActor,
  conversationId: string,
  _agentId: string,
): Promise<never> {
  await systemDb.transaction(async (tx) => {
    await lockForActor(tx, actor, conversationId);
  });
  throw new MessengerCallsNotYetError();
}

export async function removeCallAgent(
  actor: MessengerActor,
  conversationId: string,
): Promise<never> {
  await systemDb.transaction(async (tx) => {
    await lockForActor(tx, actor, conversationId);
  });
  throw new MessengerCallsNotYetError();
}

// ── History ──────────────────────────────────────────────────────────────────

export type MessengerCallsPageInput = { before?: string | null; limit?: number | null };

/** GET /api/messenger/c/:id/calls?before=<ISO>: the conversation's calls,
 *  newest first, read in the login's scope (row security answers a call as
 *  its "call started" line). An outsider hears "not found". */
export async function listCalls(
  actor: MessengerActor,
  conversationId: string,
  input: MessengerCallsPageInput = {},
): Promise<{ calls: MessengerCallView[]; hasMore: boolean }> {
  if (!isUuid(conversationId)) throw new MessengerNotFoundError();
  const [p] = await q<{ ok: number }>(
    systemDb,
    sql`select 1 as ok from messenger_participants p
          join messenger_conversations c on c.id = p.conversation_id
         where p.conversation_id = ${conversationId}::uuid and p.kind = 'login'
           and p.login_id = ${actor.loginId}::uuid and c.owner_id = ${actor.ownerId}::uuid`,
  );
  if (!p) throw new MessengerNotFoundError();
  const limit = Math.min(Math.max(1, input.limit ?? 50), 100);
  let before: Date | null = null;
  if (input.before) {
    before = new Date(input.before);
    if (Number.isNaN(before.getTime())) throw new InputError('before must be an ISO date.');
  }
  const rows = await q<CallRow>(
    db,
    sql`select id::text as id, conversation_id::text as conversation_id, room_name, kind,
               started_by::text as started_by, started_seq, started_at, ended_at, ended_reason,
               duration_s, max_participants, agent_id::text as agent_id
          from messenger_calls
         where conversation_id = ${conversationId}::uuid
           ${before ? sql`and started_at < ${before.toISOString()}::timestamptz` : sql``}
         order by started_at desc
         limit ${limit + 1}`,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const stays =
    page.length === 0
      ? []
      : await q<{
          call_id: string;
          kind: 'login' | 'agent';
          login_id: string | null;
          agent_id: string | null;
          joined_at: Date;
          left_at: Date | null;
          device: string | null;
        }>(
          db,
          sql`select call_id::text as call_id, kind, login_id::text as login_id,
                     agent_id::text as agent_id, joined_at, left_at, device
                from messenger_call_participants
               where call_id = any(${`{${page.map((r) => r.id).join(',')}}`}::uuid[])
               order by joined_at`,
        );
  const byCall = new Map<string, MessengerCallParticipantView[]>();
  for (const s of stays) {
    const list = byCall.get(s.call_id) ?? [];
    list.push({
      kind: s.kind,
      id: (s.kind === 'login' ? s.login_id : s.agent_id) ?? '',
      joinedAt: iso(s.joined_at),
      leftAt: s.left_at ? iso(s.left_at) : null,
      device: s.device,
    });
    byCall.set(s.call_id, list);
  }
  return {
    calls: page.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      kind: r.kind,
      startedBy: r.started_by,
      startedSeq: num(r.started_seq),
      startedAt: iso(r.started_at),
      endedAt: r.ended_at ? iso(r.ended_at) : null,
      endedReason: r.ended_reason,
      durationS: r.duration_s,
      maxParticipants: r.max_participants,
      participants: byCall.get(r.id) ?? [],
    })),
    hasMore,
  };
}

// ── Calls with your own assistant (section 5, last paragraph) ────────────────

/**
 * POST /api/assistant/:agentId/call (and /call/token): a token for the room
 * asst-<agent>-<login>, for an agent the login may chat with. No
 * messenger_calls row (assistant threads are not messenger rows). Answers
 * only where the agent worker is registered (MANTLE_CALLS_AGENT): until P2
 * ships the worker nothing joins the room.
 */
export async function startAssistantCall(
  actor: MessengerActor,
  agentId: string,
  input: MessengerCallStartInput & { refresh?: boolean } = {},
): Promise<MessengerCallJoinView> {
  takeBudget(actor, 'write');
  if (!callsServiceOn()) throw new MessengerCallsOffError();
  if (!callsAgentOn())
    throw new MessengerCallsOffError('Agent calls are not switched on for this brain.');
  deviceOr(input.device);
  if (!isUuid(agentId)) throw new MessengerNotFoundError('Agent not found.');
  const agents = await messengerChatAgents(actor.ownerId, actor.loginId);
  if (!agents.some((a) => a.id === agentId.toLowerCase())) {
    throw new MessengerNotFoundError('Agent not found among the agents you may chat with.');
  }
  const names = await loginNames([actor.loginId]);
  const room = assistantRoomName(agentId, actor.loginId);
  const lk = livekitClient();
  const info = await lk.ensureRoom(room, {
    emptyTimeoutS: CALL_ROOM_EMPTY_TIMEOUT_S,
    maxParticipants: 2,
  });
  const identity = loginIdentity(actor.loginId);
  if (!input.refresh) await lk.removeParticipant(room, identity).catch(() => {});
  return joinView(null, room, identity, names.get(actor.loginId) ?? 'Someone', info.turnPassword);
}

// ── The webhook (section 9, "POST /api/livekit/webhook") ─────────────────────

export type MessengerWebhookOutcome = 'applied' | 'duplicate' | 'ignored';

/**
 * Apply one verified LiveKit event. Replay-safe: the event id goes into
 * messenger_call_webhooks first, and a second delivery changes nothing.
 * Rooms the brain holds no open call for (an assistant room, a room closed
 * already) are ignored, their id still kept.
 */
export async function applyCallWebhook(ev: LivekitWebhook): Promise<MessengerWebhookOutcome> {
  if (!ev.id || ev.id.length > 200 || !ev.event || ev.event.length > 64) {
    throw new InputError('not a webhook event');
  }
  // A login the chat does not admit (a leaver, a removed one, with a token
  // still in hand): no stay, and the room drops it after commit.
  let dropIdentity: string | null = null;
  const outcome = await systemDb.transaction(async (tx) => {
    const fresh = await tx
      .insert(messengerCallWebhooks)
      .values({ eventId: ev.id, event: ev.event, roomName: ev.roomName })
      .onConflictDoNothing()
      .returning({ id: messengerCallWebhooks.eventId });
    if (fresh.length === 0) return 'duplicate';
    if (!ev.roomName || !ev.roomName.startsWith('msgr-')) return 'ignored';
    const locked = await lockConversationAndCall(tx, ev.roomName);
    if (!locked) return 'ignored';
    const { conv, call } = locked;
    switch (ev.event) {
      case 'participant_joined': {
        const who = whoOf(ev);
        if (!who || !(await isKnown(tx, who))) return 'ignored';
        if ('loginId' in who && !(await isLiveParticipant(tx, call.conversation_id, who.loginId))) {
          dropIdentity = ev.participant?.identity ?? null;
          return 'ignored';
        }
        await openStay(tx, call, who, null);
        return 'applied';
      }
      case 'participant_left':
      case 'participant_connection_aborted': {
        const who = whoOf(ev);
        if (!who) return 'ignored';
        await closeStay(tx, call.id, who);
        return 'applied';
      }
      case 'room_finished':
        await closeCall(tx, conv, call, 'finished');
        return 'applied';
      default:
        return 'ignored';
    }
  });
  if (dropIdentity && ev.roomName && callsServiceOn()) {
    await livekitClient()
      .removeParticipant(ev.roomName, dropIdentity)
      .catch(() => {});
  }
  return outcome;
}

/** The login or agent exists (the stay's foreign keys); an identity that
 *  names nobody is ignored, never an error. */
async function isKnown(tx: Tx, who: { loginId: string } | { agentId: string }): Promise<boolean> {
  const [row] =
    'loginId' in who
      ? await q<{ ok: number }>(
          tx,
          sql`select 1 as ok from auth.users where id = ${who.loginId}::uuid`,
        )
      : await q<{ ok: number }>(
          tx,
          sql`select 1 as ok from agents where id = ${who.agentId}::uuid`,
        );
  return Boolean(row);
}

/** The login is a live participant of the conversation (the chat's gate
 *  holds for the room: a leaver or a removed login is dropped). */
async function isLiveParticipant(
  tx: Tx,
  conversationId: string,
  loginId: string,
): Promise<boolean> {
  const [row] = await q<{ ok: number }>(
    tx,
    sql`select 1 as ok from messenger_participants
         where conversation_id = ${conversationId}::uuid and kind = 'login'
           and login_id = ${loginId}::uuid and left_at is null`,
  );
  return Boolean(row);
}

function whoOf(ev: LivekitWebhook): { loginId: string } | { agentId: string } | null {
  const identity = ev.participant?.identity ?? '';
  const loginId = identityLoginId(identity);
  if (loginId) return { loginId };
  const agentId = identityAgentId(identity);
  if (agentId) return { agentId };
  return null;
}

// ── The reconciler (section 5, "Truth when webhooks are lost") ───────────────

export type MessengerReconcileReport = {
  open: number;
  closed: { reconciled: number; cap_reached: number; service_off: number };
  corrected: number;
  /** LiveKit did not answer: nothing was closed on that account. */
  unreachable: boolean;
};

/**
 * One pass over every open call (the events worker, every minute): a row
 * whose room is gone closes as reconciled; one past MANTLE_CALLS_MAX_MINUTES
 * closes as cap_reached and its room is deleted (everyone dropped, one line
 * says why); with the service off every row closes as service_off. Stays
 * are corrected to the room's list. A LiveKit that does not answer closes
 * nothing. It only ever closes: it starts no call and no job.
 */
export async function reconcileCalls(
  opts: { serviceOn?: boolean; client?: LivekitClient } = {},
): Promise<MessengerReconcileReport> {
  const report: MessengerReconcileReport = {
    open: 0,
    closed: { reconciled: 0, cap_reached: 0, service_off: 0 },
    corrected: 0,
    unreachable: false,
  };
  await systemDb
    .delete(messengerCallWebhooks)
    .where(
      sql`${messengerCallWebhooks.receivedAt} < now() - make_interval(secs => ${WEBHOOK_KEEP_MS / 1000})`,
    );
  const open = await q<{
    id: string;
    room_name: string;
    conversation_id: string;
    age_s: string | number;
  }>(
    systemDb,
    sql`select id::text as id, room_name, conversation_id::text as conversation_id,
               floor(extract(epoch from (now() - started_at))) as age_s
          from messenger_calls where ended_at is null order by started_at`,
  );
  report.open = open.length;
  if (open.length === 0) return report;
  const serviceOn = opts.serviceOn ?? callsServiceOn();
  const closeAs = async (
    room: string,
    reason: 'reconciled' | 'cap_reached' | 'service_off',
  ): Promise<void> => {
    await systemDb.transaction(async (tx) => {
      const locked = await lockConversationAndCall(tx, room);
      if (!locked) return;
      await closeCall(tx, locked.conv, locked.call, reason);
      report.closed[reason] += 1;
    });
  };
  if (!serviceOn) {
    for (const c of open) await closeAs(c.room_name, 'service_off');
    return report;
  }
  const lk = opts.client ?? livekitClient();
  const capS = CALLS_MAX_MINUTES() * 60;
  for (const c of open) {
    let parts: Awaited<ReturnType<LivekitClient['listParticipants']>>;
    try {
      if (num(c.age_s) >= capS) {
        await lk.deleteRoom(c.room_name);
        await closeAs(c.room_name, 'cap_reached');
        continue;
      }
      parts = await lk.listParticipants(c.room_name);
    } catch (err) {
      if (err instanceof LivekitUnavailableError) {
        report.unreachable = true;
        return report;
      }
      throw err;
    }
    if (parts === null) {
      await closeAs(c.room_name, 'reconciled');
      continue;
    }
    const present = parts;
    // Identities in the room that the chat does not admit: dropped from the
    // room after the transaction (the chat's gate holds for the room).
    const dropFromRoom: string[] = [];
    await systemDb.transaction(async (tx) => {
      const locked = await lockConversationAndCall(tx, c.room_name);
      if (!locked) return;
      const { call } = locked;
      const stays = await q<{
        kind: 'login' | 'agent';
        login_id: string | null;
        agent_id: string | null;
      }>(
        tx,
        sql`select kind, login_id::text as login_id, agent_id::text as agent_id
              from messenger_call_participants where call_id = ${call.id}::uuid and left_at is null`,
      );
      const inRoom = new Set<string>();
      for (const p of present) {
        const who = whoOf({
          id: '',
          event: '',
          roomName: null,
          participant: { identity: p.identity, name: p.name },
          createdAt: null,
        });
        if (!who) continue;
        if ('loginId' in who && !(await isLiveParticipant(tx, call.conversation_id, who.loginId))) {
          dropFromRoom.push(p.identity);
          continue;
        }
        if (!(await isKnown(tx, who))) continue;
        inRoom.add('loginId' in who ? `login:${who.loginId}` : `agent:${who.agentId}`);
        const had = stays.some((s) =>
          'loginId' in who
            ? s.kind === 'login' && s.login_id === who.loginId
            : s.kind === 'agent' && s.agent_id === who.agentId,
        );
        if (!had) {
          await openStay(tx, call, who, null);
          report.corrected += 1;
        }
      }
      for (const s of stays) {
        const key = s.kind === 'login' ? `login:${s.login_id}` : `agent:${s.agent_id}`;
        if (inRoom.has(key)) continue;
        const who = s.kind === 'login' ? { loginId: s.login_id! } : { agentId: s.agent_id! };
        if (await closeStay(tx, call.id, who)) report.corrected += 1;
      }
    });
    for (const identity of dropFromRoom) {
      await lk.removeParticipant(c.room_name, identity).catch(() => {});
      report.corrected += 1;
    }
  }
  return report;
}

/** The worker's tick: at most one pass a minute per process, never
 *  throws (a failed pass is logged and the next minute tries again). */
let lastReconcileAt = 0;
let reconciling = false;
export async function maybeReconcileCalls(now = Date.now()): Promise<void> {
  if (reconciling || now - lastReconcileAt < 60_000) return;
  reconciling = true;
  lastReconcileAt = now;
  try {
    const r = await reconcileCalls();
    const closed = r.closed.reconciled + r.closed.cap_reached + r.closed.service_off;
    if (closed > 0 || r.corrected > 0 || r.unreachable) {
      log('calls').info(
        `reconciled: ${r.open} open, closed ${closed} (gone ${r.closed.reconciled}, cap ${r.closed.cap_reached}, off ${r.closed.service_off}), corrected ${r.corrected}${r.unreachable ? ', LiveKit did not answer' : ''}`,
      );
    }
  } catch (err) {
    log('calls').error('reconcile failed:', err);
  } finally {
    reconciling = false;
  }
}

/** Tests only: forget the throttle. */
export function resetCallReconcileForTests(): void {
  lastReconcileAt = 0;
  reconciling = false;
}

export { MessengerRefusedError };
