/**
 * The messenger (Messenger V1, plan page d8954876, sections 3, 4, 8, 10, 11
 * and 20): direct chats and groups between the logins of one brain.
 *
 * One function per action, each one transaction. The rules that hold for
 * every function:
 *
 *  - Writes run on the system pool (ACCESS_MATRIX writer 'system'), each
 *    checking the actor's participant row in the same transaction. A send
 *    locks the conversation row (SELECT FOR UPDATE), takes last_seq + 1 and
 *    writes last_seq, last_message_at and last_preview with the message, so
 *    writers to one conversation serialise and seq has no gap and no
 *    duplicate.
 *  - Reads of the messenger tables run on `db`, which is the login's scope
 *    inside a request or an MCP call: row security keys every row on the
 *    participant row (mantle_messenger_seq_cap, migration 0335). Each read
 *    also names the login in its own WHERE, so a read that ever ran outside
 *    a scope still answers only the login's rows. Names, presence and agents
 *    are read on the system pool for ids that read returned.
 *  - Not a participant reads as "not found", never "forbidden": a chat's
 *    existence is not told to an outsider. There is no Admin exception.
 *  - Nothing here starts LLM work: a mention is stored and enqueues nothing
 *    (Phase 3 adds the group turn), and no trigger spends.
 */
import { and, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import {
  db,
  liveWorkspaceSql,
  loginPresence,
  messengerConversations,
  messengerFavourites,
  messengerMessages,
  messengerParticipants,
  messengerReactions,
  systemDb,
} from '@mantle/db';
import { InputError, defineDomainError, isUuid } from '@mantle/std';
import { workspaceAssistants } from './team-assistant';

// ── Limits (plan section 14) ─────────────────────────────────────────────────

export const MESSENGER_BODY_MAX = 8000;
export const MESSENGER_PARTICIPANTS_MAX = 200;
export const MESSENGER_TITLE_MAX = 200;
export const MESSENGER_PAGE_DEFAULT = 20;
export const MESSENGER_PAGE_MAX = 100;
export const MESSENGER_PREVIEW_CHARS = 140;
export const MESSENGER_CLIENT_MSG_MAX = 100;
export const MESSENGER_EMOJI_MAX = 32;
/** "Online": active within this long (plan section 7). */
export const MESSENGER_ONLINE_MS = 2 * 60 * 1000;
/** Roles that hold a back-and-forth chat (mirrors listAssistantAgents). */
const CHATTABLE_ROLES = ['assistant', 'responder', 'custom'] as const;

// ── Errors ───────────────────────────────────────────────────────────────────

/** No such conversation or message for this login: also what a
 *  non-participant hears, so an outsider learns nothing. */
export class MessengerNotFoundError extends Error {
  constructor(message = 'No such conversation.') {
    super(message);
    this.name = 'MessengerNotFoundError';
  }
}
defineDomainError(MessengerNotFoundError, {
  reason: 'no such conversation or message for this login (an outsider hears the same)',
  status: 404,
});

/** A participant asked for what the chat does not allow it (a non-admin renames
 *  a group, someone edits another's message). */
export class MessengerRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessengerRefusedError';
  }
}
defineDomainError(MessengerRefusedError, {
  reason: 'a participant asked for what the chat does not allow it; the message says which',
  status: 403,
});

// ── Types ────────────────────────────────────────────────────────────────────

/** Who acts: the login, in the brain `ownerId`, and the credential the
 *  call came through (an MCP connection, an API key, a peer), if any. */
export type MessengerActor = {
  ownerId: string;
  loginId: string;
  via?: MessengerVia | null;
};

/** How a message was sent: `label` is shown, `ref` names the credential
 *  (oauth:<client id>, key:<key id>, peer:<peer id>). */
export type MessengerVia = { label: string | null; ref: string };

export type MessengerMention = { kind: 'login' | 'agent'; id: string };

export type MessengerParticipantView = {
  kind: 'login' | 'agent';
  id: string;
  name: string;
  admin: boolean;
  leftAt: string | null;
};

export type MessengerPreviewView = {
  authorName: string | null;
  text: string;
  authorKind: 'login' | 'agent' | 'system';
};

export type MessengerConversationView = {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  createdBy: string | null;
  createdAt: string;
  archivedAt: string | null;
  lastSeq: number;
  lastMessageAt: string | null;
  workspaceId: string | null;
  agentId: string | null;
  participants: MessengerParticipantView[];
  me: {
    admin: boolean;
    lastReadSeq: number;
    clearedBeforeSeq: number;
    muted: boolean;
    leftSeq: number | null;
  };
};

export type MessengerMessageView = {
  id: string;
  conversationId: string;
  seq: number;
  authorKind: 'login' | 'agent' | 'system';
  authorId: string | null;
  authorName: string | null;
  via: string | null;
  body: string;
  attachments: string[];
  mentions: MessengerMention[];
  replyToSeq: number | null;
  clientMsgId: string | null;
  status: 'complete' | 'pending' | 'failed';
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  reactions: { emoji: string; count: number; mine: boolean }[];
};

export type MessengerListRowView = {
  kind: 'direct' | 'group' | 'agent';
  id: string;
  title: string;
  lastSeq: number | null;
  lastMessageAt: string | null;
  preview: MessengerPreviewView | null;
  unread: number;
  mention: boolean;
  muted: boolean;
  favourite: boolean;
  participants: MessengerParticipantView[];
  agentSlug?: string;
};

export type MessengerDirectoryEntryView = {
  kind: 'login' | 'agent';
  id: string;
  name: string;
  online: boolean;
  slug?: string;
};

// ── Small helpers ────────────────────────────────────────────────────────────

type Exec = { execute: (q: SQL) => Promise<unknown> };

async function q<T>(on: Exec, query: SQL): Promise<T[]> {
  return (await on.execute(query)) as unknown as T[];
}

/** A bigint from the driver (a string) or a number, as a number. */
function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function isoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : iso(v);
}

function uuidOr(v: string, what: string): string {
  if (!isUuid(v)) throw new InputError(`${what} is not an id.`);
  return v.toLowerCase();
}

function seqOr(v: number, what: string): number {
  if (!Number.isSafeInteger(v) || v < 0) throw new InputError(`${what} is not a sequence number.`);
  return v;
}

function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(',')}}`}::uuid[]`;
}

/** The two logins of a direct chat, sorted and joined: one key per pair. */
export function directKey(a: string, b: string): string {
  return [a.toLowerCase(), b.toLowerCase()].sort().join(':');
}

function previewOf(body: string): string {
  return body.length > MESSENGER_PREVIEW_CHARS ? body.slice(0, MESSENGER_PREVIEW_CHARS) : body;
}

/** A login's shown name (display name, else the mailbox part), read on the
 *  system pool. */
async function loginNames(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await q<{ id: string; name: string }>(
    systemDb,
    sql`select id::text as id,
               coalesce(nullif(btrim(display_name), ''), split_part(coalesce(email, ''), '@', 1), 'User') as name
          from auth.users where id = any(${uuidArray(ids)})`,
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function agentNames(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await q<{ id: string; name: string }>(
    systemDb,
    sql`select id::text as id, name from agents where id = any(${uuidArray(ids)})`,
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Whether a login is an Admin user (a user of the live Admin workspace). */
export async function messengerIsAdmin(loginId: string): Promise<boolean> {
  const [row] = await q<{ admin: boolean }>(
    systemDb,
    sql`select coalesce("public"."mantle_login_is_admin"(${loginId}::uuid), false) as admin`,
  );
  return row?.admin === true;
}

// ── The directory (plan section 4, decision 19.1 A) ──────────────────────────

/** The logins `loginId` may start a chat with or add to a group: those
 *  that share a live workspace with it, or every usable login for an Admin
 *  user. Never itself. One query over workspace_users. */
async function reachableLogins(
  loginId: string,
  opts: { only?: readonly string[]; q?: string; limit?: number } = {},
): Promise<{ id: string; name: string; lastActiveAt: Date | null }[]> {
  const admin = await messengerIsAdmin(loginId);
  const only = opts.only ? sql`and u.id = any(${uuidArray(opts.only)})` : sql``;
  const like = opts.q
    ? sql`and (u.display_name ilike ${'%' + escapeLike(opts.q) + '%'} or u.email ilike ${'%' + escapeLike(opts.q) + '%'})`
    : sql``;
  const reach = admin
    ? sql``
    : sql`and exists (
            select 1 from workspace_users mine
              join workspace_users theirs on theirs.workspace_id = mine.workspace_id
              join workspaces w on w.id = mine.workspace_id and ${liveWorkspaceSql('w')}
             where mine.login_id = ${loginId}::uuid and theirs.login_id = u.id)`;
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const rows = await q<{ id: string; name: string; last_active_at: Date | null }>(
    systemDb,
    sql`select u.id::text as id,
               coalesce(nullif(btrim(u.display_name), ''), split_part(u.email, '@', 1)) as name,
               p.last_active_at
          from auth.users u
          left join login_presence p on p.login_id = u.id
         where u.id <> ${loginId}::uuid
           and u.email is not null and u.disabled_at is null
           ${reach} ${only} ${like}
         order by 2
         limit ${limit}`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    lastActiveAt: r.last_active_at ? new Date(r.last_active_at) : null,
  }));
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The agents a login may chat with (plan sections 4 and 5): the assistant of
 * each workspace it is a user of; for an Admin user every chat-capable
 * agent except the assistants of non-Admin workspaces it is not in. The
 * rule of server/web/lib/assistant-chat.ts listChatAgents, read here so the
 * MCP tools answer the same.
 */
export async function messengerChatAgents(
  ownerId: string,
  loginId: string,
): Promise<{ id: string; slug: string; name: string }[]> {
  if (await messengerIsAdmin(loginId)) {
    const [all, mine, others] = await Promise.all([
      q<{ id: string; slug: string; name: string }>(
        systemDb,
        sql`select id::text as id, slug, name from agents
             where owner_id = ${ownerId}::uuid and enabled
               and role = any(${`{${CHATTABLE_ROLES.join(',')}}`}::text[])
             order by priority desc, name`,
      ),
      workspaceAssistants(ownerId, loginId),
      workspaceAssistants(ownerId),
    ]);
    const otherIds = new Set(others.filter((a) => !a.isAdmin).map((a) => a.id));
    const mineIds = new Set(mine.map((a) => a.id));
    return all.filter((a) => !otherIds.has(a.id) || mineIds.has(a.id));
  }
  return (await workspaceAssistants(ownerId, loginId))
    .filter((a) => !a.isAdmin)
    .map((a) => ({ id: a.id, slug: a.slug, name: a.name }));
}

/** GET /api/messenger/directory: people sharing a workspace with me (Admin
 *  users: everyone), then the agents I may chat with, with "online". */
export async function messengerDirectory(
  actor: MessengerActor,
  query = '',
): Promise<MessengerDirectoryEntryView[]> {
  const term = query.trim().slice(0, 100);
  const now = Date.now();
  const [people, agents] = await Promise.all([
    reachableLogins(actor.loginId, { q: term || undefined }),
    messengerChatAgents(actor.ownerId, actor.loginId),
  ]);
  const t = term.toLowerCase();
  return [
    ...people.map((p) => ({
      kind: 'login' as const,
      id: p.id,
      name: p.name,
      online: !!p.lastActiveAt && now - p.lastActiveAt.getTime() < MESSENGER_ONLINE_MS,
    })),
    ...agents
      .filter((a) => !t || a.name.toLowerCase().includes(t) || a.slug.toLowerCase().includes(t))
      .map((a) => ({
        kind: 'agent' as const,
        id: a.id,
        name: a.name,
        online: false,
        slug: a.slug,
      })),
  ];
}

// ── Participant checks (system pool, inside the write's transaction) ─────────

type Tx = Parameters<Parameters<typeof systemDb.transaction>[0]>[0];

type ParticipantRow = {
  id: string;
  admin: boolean;
  left_at: Date | null;
  left_seq: string | number | null;
  last_read_seq: string | number;
  cleared_before_seq: string | number;
  muted: boolean;
};

type ConversationRow = {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  archived_at: Date | null;
  last_seq: string | number;
  workspace_id: string | null;
  agent_id: string | null;
};

/** Lock the conversation and read the actor's participant row; "not found"
 *  for a login that holds none (or a conversation of another brain). */
async function lockForActor(
  tx: Tx,
  actor: MessengerActor,
  conversationId: string,
  opts: { live: boolean } = { live: true },
): Promise<{ conv: ConversationRow; me: ParticipantRow }> {
  const c = uuidOr(conversationId, 'The conversation');
  const [conv] = await q<ConversationRow>(
    tx,
    sql`select id::text as id, kind, title, archived_at, last_seq,
               workspace_id::text as workspace_id, agent_id::text as agent_id
          from messenger_conversations
         where id = ${c}::uuid and owner_id = ${actor.ownerId}::uuid
         for update`,
  );
  if (!conv) throw new MessengerNotFoundError();
  const [me] = await q<ParticipantRow>(
    tx,
    sql`select id::text as id, admin, left_at, left_seq, last_read_seq, cleared_before_seq, muted
          from messenger_participants
         where conversation_id = ${c}::uuid and kind = 'login' and login_id = ${actor.loginId}::uuid`,
  );
  if (!me) throw new MessengerNotFoundError();
  if (opts.live && me.left_at) throw new MessengerRefusedError('You left this chat.');
  return { conv, me };
}

function requireGroupAdmin(conv: ConversationRow, me: ParticipantRow): void {
  if (conv.kind !== 'group') throw new MessengerRefusedError('A direct chat has no admin.');
  if (!me.admin) throw new MessengerRefusedError('Only a group admin may do that.');
}

/** Insert one message at last_seq + 1 and move the conversation's
 *  counters, in the caller's transaction (the conversation row is locked).
 *  The one place a seq is taken. */
async function appendMessage(
  tx: Tx,
  conv: ConversationRow,
  m: {
    authorKind: 'login' | 'agent' | 'system';
    authorLoginId: string | null;
    authorName: string | null;
    via: MessengerVia | null;
    body: string;
    mentions: MessengerMention[];
    replyToSeq: number | null;
    clientMsgId: string | null;
  },
): Promise<number> {
  const seq = num(conv.last_seq) + 1;
  await tx.insert(messengerMessages).values({
    conversationId: conv.id,
    seq,
    authorKind: m.authorKind,
    authorLoginId: m.authorLoginId,
    authorName: m.authorName,
    via: m.via?.label ?? null,
    viaRef: m.via?.ref ?? null,
    body: m.body,
    mentions: m.mentions,
    replyToSeq: m.replyToSeq,
    clientMsgId: m.clientMsgId,
  });
  await tx
    .update(messengerConversations)
    .set({
      lastSeq: seq,
      lastMessageAt: sql`now()`,
      lastPreview: { authorName: m.authorName, text: previewOf(m.body), authorKind: m.authorKind },
    })
    .where(eq(messengerConversations.id, conv.id));
  conv.last_seq = seq;
  return seq;
}

async function systemLine(tx: Tx, conv: ConversationRow, body: string): Promise<number> {
  return appendMessage(tx, conv, {
    authorKind: 'system',
    authorLoginId: null,
    authorName: null,
    via: null,
    body,
    mentions: [],
    replyToSeq: null,
    clientMsgId: null,
  });
}

/** One participant row's own columns, by its id. */
function updateParticipant(
  tx: Tx,
  id: string,
  set: Partial<typeof messengerParticipants.$inferInsert>,
) {
  return tx.update(messengerParticipants).set(set).where(eq(messengerParticipants.id, id));
}

// ── Create ───────────────────────────────────────────────────────────────────

export type MessengerCreateInput = {
  kind: 'direct' | 'group';
  /** Login ids besides the actor. */
  participants: readonly string[];
  title?: string | null;
};

/**
 * Create a conversation (POST /api/messenger/conversations). A direct chat
 * names exactly one other login; the pair has one chat, so a second create
 * answers the existing one (`created: false`). A group names any number of
 * others up to the cap, none included (a group of one: "message yourself",
 * decision 19.3 B). Everyone named must be in the actor's directory.
 */
export async function createMessengerConversation(
  actor: MessengerActor,
  input: MessengerCreateInput,
): Promise<{ conversationId: string; created: boolean }> {
  if (input.kind !== 'direct' && input.kind !== 'group') {
    throw new InputError('A conversation is direct or group.');
  }
  const self = actor.loginId.toLowerCase();
  const others = [...new Set(input.participants.map((p) => uuidOr(p, 'A participant')))].filter(
    (p) => p !== self,
  );
  if (input.kind === 'direct' && others.length !== 1) {
    throw new InputError('A direct chat names exactly one other person.');
  }
  if (others.length + 1 > MESSENGER_PARTICIPANTS_MAX) {
    throw new InputError(`A group holds at most ${MESSENGER_PARTICIPANTS_MAX} people.`);
  }
  const title = input.kind === 'group' ? (input.title ?? '').trim() || null : null;
  if (title && title.length > MESSENGER_TITLE_MAX) {
    throw new InputError(`A title is at most ${MESSENGER_TITLE_MAX} characters.`);
  }
  if (others.length > 0) {
    const reach = await reachableLogins(actor.loginId, { only: others, limit: 500 });
    if (reach.length !== others.length) {
      throw new MessengerRefusedError(
        'You can only start a chat with people who share a workspace with you.',
      );
    }
  }

  if (input.kind === 'direct') {
    const other = others[0]!;
    const key = directKey(self, other);
    return systemDb.transaction(async (tx) => {
      const [made] = await tx
        .insert(messengerConversations)
        .values({ ownerId: actor.ownerId, kind: 'direct', directKey: key, createdBy: self })
        .onConflictDoNothing({
          target: messengerConversations.directKey,
          where: sql`${messengerConversations.directKey} is not null`,
        })
        .returning({ id: messengerConversations.id });
      if (!made) {
        const [found] = await q<{ id: string }>(
          tx,
          sql`select id::text as id from messenger_conversations
               where direct_key = ${key} and owner_id = ${actor.ownerId}::uuid`,
        );
        if (!found) throw new MessengerNotFoundError();
        return { conversationId: found.id, created: false };
      }
      await tx.insert(messengerParticipants).values([
        { conversationId: made.id, kind: 'login', loginId: self, addedBy: self },
        { conversationId: made.id, kind: 'login', loginId: other, addedBy: self },
      ]);
      return { conversationId: made.id, created: true };
    });
  }

  return systemDb.transaction(async (tx) => {
    const [made] = await tx
      .insert(messengerConversations)
      .values({ ownerId: actor.ownerId, kind: 'group', title, createdBy: self })
      .returning({ id: messengerConversations.id });
    await tx.insert(messengerParticipants).values(
      [self, ...others].map((l) => ({
        conversationId: made!.id,
        kind: 'login' as const,
        loginId: l,
        admin: l === self,
        addedBy: self,
      })),
    );
    return { conversationId: made!.id, created: true };
  });
}

// ── Send, edit, delete, react ────────────────────────────────────────────────

export type MessengerSendInput = {
  body: string;
  mentions?: readonly MessengerMention[];
  replyToSeq?: number | null;
  clientMsgId?: string | null;
  attachments?: readonly string[];
};

/**
 * Send a message as the actor (POST /api/messenger/c/:id/messages). The
 * same clientMsgId from the same login in the same conversation stores one
 * row and answers it again (`created: false`). A mention names a live
 * participant; it moves that login's mention_seq and starts nothing
 * (Phase 1: no agent turn). The author's own read cursor moves to the new
 * seq.
 */
export async function sendMessengerMessage(
  actor: MessengerActor,
  conversationId: string,
  input: MessengerSendInput,
): Promise<{ message: MessengerMessageView; created: boolean }> {
  const body = typeof input.body === 'string' ? input.body : '';
  if (body.trim() === '') throw new InputError('A message needs some text.');
  if (body.length > MESSENGER_BODY_MAX) {
    throw new InputError(`A message is at most ${MESSENGER_BODY_MAX} characters.`);
  }
  if (input.attachments && input.attachments.length > 0) {
    throw new InputError('Attachments are not available yet.');
  }
  const clientMsgId = input.clientMsgId ? String(input.clientMsgId) : null;
  if (clientMsgId && clientMsgId.length > MESSENGER_CLIENT_MSG_MAX) {
    throw new InputError(`A client message id is at most ${MESSENGER_CLIENT_MSG_MAX} characters.`);
  }
  const mentions = dedupeMentions(input.mentions ?? []);
  const replyTo = input.replyToSeq == null ? null : seqOr(input.replyToSeq, 'reply_to_seq');
  const self = actor.loginId.toLowerCase();

  const out = await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    if (conv.archived_at) throw new MessengerRefusedError('This chat is archived.');
    if (clientMsgId) {
      const [prior] = await q<{ seq: string | number }>(
        tx,
        sql`select seq from messenger_messages
             where conversation_id = ${conv.id}::uuid and author_login_id = ${self}::uuid
               and client_msg_id = ${clientMsgId}`,
      );
      if (prior) return { seq: num(prior.seq), created: false };
    }
    if (replyTo !== null && (replyTo < 1 || replyTo > num(conv.last_seq))) {
      throw new InputError('reply_to_seq names no message of this chat.');
    }
    if (mentions.length > 0) {
      const live = await q<{ kind: 'login' | 'agent'; id: string }>(
        tx,
        sql`select kind, coalesce(login_id, agent_id)::text as id from messenger_participants
             where conversation_id = ${conv.id}::uuid and left_at is null`,
      );
      const ok = new Set(live.map((p) => `${p.kind}:${p.id}`));
      for (const m of mentions) {
        if (!ok.has(`${m.kind}:${m.id}`)) {
          throw new InputError('A mention names no one in this chat.');
        }
      }
    }
    const names = await loginNames([self]);
    const seq = await appendMessage(tx, conv, {
      authorKind: 'login',
      authorLoginId: self,
      authorName: names.get(self) ?? null,
      via: actor.via ?? null,
      body,
      mentions,
      replyToSeq: replyTo,
      clientMsgId,
    });
    const mentioned = mentions.filter((m) => m.kind === 'login' && m.id !== self).map((m) => m.id);
    if (mentioned.length > 0) {
      await tx
        .update(messengerParticipants)
        .set({ mentionSeq: seq })
        .where(
          and(
            eq(messengerParticipants.conversationId, conv.id),
            eq(messengerParticipants.kind, 'login'),
            inArray(messengerParticipants.loginId, mentioned),
          ),
        );
    }
    if (num(me.last_read_seq) < seq) await updateParticipant(tx, me.id, { lastReadSeq: seq });
    return { seq, created: true };
  });
  const [message] = await readMessagesBySeq(actor, conversationId, [out.seq]);
  if (!message) throw new MessengerNotFoundError();
  return { message, created: out.created };
}

function dedupeMentions(list: readonly MessengerMention[]): MessengerMention[] {
  const seen = new Set<string>();
  const out: MessengerMention[] = [];
  for (const m of list) {
    if (!m || (m.kind !== 'login' && m.kind !== 'agent')) {
      throw new InputError('A mention is a login or an agent.');
    }
    const id = uuidOr(String(m.id), 'A mention');
    const k = `${m.kind}:${id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind: m.kind, id });
  }
  if (out.length > MESSENGER_PARTICIPANTS_MAX) throw new InputError('Too many mentions.');
  return out;
}

type LockedMessage = {
  id: string;
  author_kind: string;
  author_login_id: string | null;
  deleted_at: Date | null;
};

async function lockMessage(tx: Tx, conversationId: string, seq: number): Promise<LockedMessage> {
  const [m] = await q<LockedMessage>(
    tx,
    sql`select id::text as id, author_kind, author_login_id::text as author_login_id, deleted_at
          from messenger_messages where conversation_id = ${conversationId}::uuid and seq = ${seq}
          for update`,
  );
  if (!m) throw new MessengerNotFoundError('No such message.');
  return m;
}

/** Keep the conversation's preview right when its last message changes. */
async function refreshPreviewIfLast(tx: Tx, conv: ConversationRow, seq: number): Promise<void> {
  if (seq !== num(conv.last_seq)) return;
  const [m] = await q<{
    author_name: string | null;
    body: string;
    author_kind: 'login' | 'agent' | 'system';
    deleted_at: Date | null;
  }>(
    tx,
    sql`select author_name, body, author_kind, deleted_at from messenger_messages
         where conversation_id = ${conv.id}::uuid and seq = ${seq}`,
  );
  if (!m) return;
  await tx
    .update(messengerConversations)
    .set({
      lastPreview: {
        authorName: m.author_name,
        text: m.deleted_at ? '' : previewOf(m.body),
        authorKind: m.author_kind,
      },
    })
    .where(eq(messengerConversations.id, conv.id));
}

/** Edit my own message (PATCH .../messages/:seq): edited_at set. An
 *  agent's message is never edited. */
export async function editMessengerMessage(
  actor: MessengerActor,
  conversationId: string,
  seq: number,
  body: string,
): Promise<MessengerMessageView> {
  const s = seqOr(seq, 'seq');
  if (typeof body !== 'string' || body.trim() === '') {
    throw new InputError('A message needs some text.');
  }
  if (body.length > MESSENGER_BODY_MAX) {
    throw new InputError(`A message is at most ${MESSENGER_BODY_MAX} characters.`);
  }
  await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    if (s <= num(me.cleared_before_seq)) throw new MessengerNotFoundError('No such message.');
    const m = await lockMessage(tx, conv.id, s);
    if (m.author_kind !== 'login' || m.author_login_id !== actor.loginId.toLowerCase()) {
      throw new MessengerRefusedError('You can only edit your own messages.');
    }
    if (m.deleted_at) throw new MessengerRefusedError('A deleted message cannot be edited.');
    await tx
      .update(messengerMessages)
      .set({ body, editedAt: sql`now()` })
      .where(eq(messengerMessages.id, m.id));
    await refreshPreviewIfLast(tx, conv, s);
  });
  const [message] = await readMessagesBySeq(actor, conversationId, [s]);
  if (!message) throw new MessengerNotFoundError('No such message.');
  return message;
}

/** Delete a message for everyone (soft: body blanked, deleted_at set): the
 *  author, or a group admin for any message of the group. */
export async function deleteMessengerMessage(
  actor: MessengerActor,
  conversationId: string,
  seq: number,
): Promise<void> {
  const s = seqOr(seq, 'seq');
  await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    if (s <= num(me.cleared_before_seq)) throw new MessengerNotFoundError('No such message.');
    const m = await lockMessage(tx, conv.id, s);
    if (m.deleted_at) return;
    const mine = m.author_kind === 'login' && m.author_login_id === actor.loginId.toLowerCase();
    const groupAdmin = conv.kind === 'group' && me.admin;
    if (!mine && !groupAdmin) {
      throw new MessengerRefusedError('You can only delete your own messages.');
    }
    await tx
      .update(messengerMessages)
      .set({ body: '', mentions: [], attachments: [], deletedAt: sql`now()` })
      .where(eq(messengerMessages.id, m.id));
    await tx.delete(messengerReactions).where(eq(messengerReactions.messageId, m.id));
    await refreshPreviewIfLast(tx, conv, s);
  });
}

/** Toggle one emoji of mine on a message (POST .../messages/:seq/reactions).
 *  Answers whether the reaction is now on. */
export async function toggleMessengerReaction(
  actor: MessengerActor,
  conversationId: string,
  seq: number,
  emoji: string,
): Promise<{ on: boolean }> {
  const s = seqOr(seq, 'seq');
  const e = typeof emoji === 'string' ? emoji.trim() : '';
  if (e === '' || e.length > MESSENGER_EMOJI_MAX || /\s/.test(e)) {
    throw new InputError('A reaction is one emoji.');
  }
  const self = actor.loginId.toLowerCase();
  return systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    if (s <= num(me.cleared_before_seq)) throw new MessengerNotFoundError('No such message.');
    const m = await lockMessage(tx, conv.id, s);
    if (m.deleted_at) throw new MessengerRefusedError('A deleted message takes no reaction.');
    const gone = await tx
      .delete(messengerReactions)
      .where(
        and(
          eq(messengerReactions.messageId, m.id),
          eq(messengerReactions.loginId, self),
          eq(messengerReactions.emoji, e),
        ),
      )
      .returning({ emoji: messengerReactions.emoji });
    if (gone.length > 0) return { on: false };
    await tx.insert(messengerReactions).values({ messageId: m.id, loginId: self, emoji: e });
    return { on: true };
  });
}

// ── Cursors, clear, mute ─────────────────────────────────────────────────────

/** Move my read cursor forward to `seq` (never back, never past the last
 *  seq I may read). Answers the cursor. */
export async function markMessengerRead(
  actor: MessengerActor,
  conversationId: string,
  seq: number,
): Promise<{ lastReadSeq: number }> {
  const s = seqOr(seq, 'seq');
  return systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId, { live: false });
    const cap = me.left_at ? num(me.left_seq) : num(conv.last_seq);
    const next = Math.max(num(me.last_read_seq), Math.min(s, cap));
    if (next !== num(me.last_read_seq)) await updateParticipant(tx, me.id, { lastReadSeq: next });
    return { lastReadSeq: next };
  });
}

/** Clear for me (plan section 10): I see nothing up to the last seq;
 *  nobody else is affected; my unread resets. */
export async function clearMessengerForMe(
  actor: MessengerActor,
  conversationId: string,
): Promise<{ clearedBeforeSeq: number }> {
  return systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId, { live: false });
    const upTo = Math.max(
      me.left_at ? num(me.left_seq) : num(conv.last_seq),
      num(me.cleared_before_seq),
    );
    await updateParticipant(tx, me.id, {
      clearedBeforeSeq: upTo,
      lastReadSeq: Math.max(upTo, num(me.last_read_seq)),
    });
    return { clearedBeforeSeq: upTo };
  });
}

export type MessengerPatchInput = { title?: string | null; muted?: boolean };

/** PATCH /api/messenger/c/:id: the title (group admins), and my own mute.
 *  The picture, the workspace and the agent are Phase 3 and 4. */
export async function patchMessengerConversation(
  actor: MessengerActor,
  conversationId: string,
  input: MessengerPatchInput,
): Promise<void> {
  await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId, {
      live: input.title !== undefined,
    });
    if (input.title !== undefined) {
      requireGroupAdmin(conv, me);
      const title = (input.title ?? '').trim() || null;
      if (title && title.length > MESSENGER_TITLE_MAX) {
        throw new InputError(`A title is at most ${MESSENGER_TITLE_MAX} characters.`);
      }
      if (title !== conv.title) {
        await tx
          .update(messengerConversations)
          .set({ title })
          .where(eq(messengerConversations.id, conv.id));
        const names = await loginNames([actor.loginId]);
        await systemLine(
          tx,
          conv,
          `${names.get(actor.loginId) ?? 'Someone'} renamed the group${title ? ` to "${title}"` : ''}.`,
        );
      }
    }
    if (input.muted !== undefined && input.muted !== me.muted) {
      await updateParticipant(tx, me.id, { muted: input.muted === true });
    }
  });
}

/** Delete history for everyone (plan section 10): a group admin removes
 *  every message of the group, or those older than `before`. A system line
 *  records it. A direct chat has no delete-for-everyone in V1. */
export async function deleteMessengerHistory(
  actor: MessengerActor,
  conversationId: string,
  before?: Date | null,
): Promise<{ deleted: number }> {
  if (before && Number.isNaN(before.getTime())) throw new InputError('before is not a date.');
  return systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    requireGroupAdmin(conv, me);
    const gone = await tx
      .delete(messengerMessages)
      .where(
        and(
          eq(messengerMessages.conversationId, conv.id),
          before ? lt(messengerMessages.createdAt, before) : undefined,
        ),
      )
      .returning({ id: messengerMessages.id });
    const names = await loginNames([actor.loginId]);
    await systemLine(
      tx,
      conv,
      `${names.get(actor.loginId) ?? 'Someone'} deleted the history${
        before ? ` before ${before.toISOString().slice(0, 10)}` : ''
      }.`,
    );
    return { deleted: gone.length };
  });
}

// ── Membership (plan section 4) ──────────────────────────────────────────────

/** Add logins to a group (a group admin). Each must be in the actor's
 *  directory; one who left comes back (and reads the group again). */
export async function addMessengerParticipants(
  actor: MessengerActor,
  conversationId: string,
  loginIds: readonly string[],
): Promise<{ added: string[] }> {
  const self = actor.loginId.toLowerCase();
  const ids = [...new Set(loginIds.map((l) => uuidOr(l, 'A participant')))].filter(
    (l) => l !== self,
  );
  if (ids.length === 0) throw new InputError('Name someone to add.');
  const reach = await reachableLogins(actor.loginId, { only: ids, limit: 500 });
  if (reach.length !== ids.length) {
    throw new MessengerRefusedError('You can only add people who share a workspace with you.');
  }
  return systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    requireGroupAdmin(conv, me);
    if (conv.agent_id) {
      // Phase 3: a group with an agent takes only users of its workspace.
      throw new MessengerRefusedError(
        'This group has an agent; adding people arrives with agents in groups.',
      );
    }
    const rows = await q<{ login_id: string; left_at: Date | null }>(
      tx,
      sql`select login_id::text as login_id, left_at from messenger_participants
           where conversation_id = ${conv.id}::uuid and kind = 'login'`,
    );
    const liveCount = rows.filter((p) => !p.left_at).length;
    const byId = new Map(rows.map((p) => [p.login_id, p]));
    const added = ids.filter((id) => !byId.get(id) || byId.get(id)!.left_at);
    if (liveCount + added.length > MESSENGER_PARTICIPANTS_MAX) {
      throw new InputError(`A group holds at most ${MESSENGER_PARTICIPANTS_MAX} people.`);
    }
    if (added.length === 0) return { added: [] };
    const names = await loginNames([self, ...added]);
    await systemLine(
      tx,
      conv,
      `${names.get(self) ?? 'Someone'} added ${added.map((a) => names.get(a) ?? 'someone').join(', ')}.`,
    );
    await tx
      .insert(messengerParticipants)
      .values(
        added.map((id) => ({
          conversationId: conv.id,
          kind: 'login' as const,
          loginId: id,
          addedBy: self,
        })),
      )
      .onConflictDoUpdate({
        target: [messengerParticipants.conversationId, messengerParticipants.loginId],
        targetWhere: sql`${messengerParticipants.kind} = 'login'`,
        set: {
          leftAt: null,
          leftSeq: null,
          admin: false,
          joinedAt: sql`now()`,
          addedBy: self,
        },
      });
    return { added };
  });
}

/** Remove a login from a group (a group admin; not oneself: leave). The
 *  removed login keeps reading up to the line that says it was removed. */
export async function removeMessengerParticipant(
  actor: MessengerActor,
  conversationId: string,
  loginId: string,
): Promise<void> {
  const target = uuidOr(loginId, 'The participant');
  if (target === actor.loginId.toLowerCase()) {
    throw new InputError('To go yourself, leave the chat.');
  }
  await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    requireGroupAdmin(conv, me);
    const [p] = await q<{ id: string; left_at: Date | null }>(
      tx,
      sql`select id::text as id, left_at from messenger_participants
           where conversation_id = ${conv.id}::uuid and kind = 'login' and login_id = ${target}::uuid`,
    );
    if (!p || p.left_at) throw new MessengerNotFoundError('That person is not in this chat.');
    const names = await loginNames([actor.loginId, target]);
    const seq = await systemLine(
      tx,
      conv,
      `${names.get(actor.loginId) ?? 'Someone'} removed ${names.get(target) ?? 'someone'}.`,
    );
    await updateParticipant(tx, p.id, { leftAt: new Date(), leftSeq: seq, admin: false });
  });
}

/** Leave a group (anyone; a direct chat cannot be left, only cleared). The
 *  last admin who leaves hands admin to the longest-standing member; a
 *  group with no login left is archived. */
export async function leaveMessengerConversation(
  actor: MessengerActor,
  conversationId: string,
): Promise<void> {
  await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    if (conv.kind !== 'group') {
      throw new MessengerRefusedError('A direct chat cannot be left; clear it instead.');
    }
    const names = await loginNames([actor.loginId]);
    const seq = await systemLine(tx, conv, `${names.get(actor.loginId) ?? 'Someone'} left.`);
    await updateParticipant(tx, me.id, { leftAt: new Date(), leftSeq: seq, admin: false });
    const rest = await q<{ id: string; admin: boolean }>(
      tx,
      sql`select id::text as id, admin from messenger_participants
           where conversation_id = ${conv.id}::uuid and kind = 'login' and left_at is null
           order by joined_at, id`,
    );
    if (rest.length === 0) {
      await tx
        .update(messengerConversations)
        .set({ archivedAt: sql`now()` })
        .where(eq(messengerConversations.id, conv.id));
    } else if (!rest.some((p) => p.admin)) {
      await updateParticipant(tx, rest[0]!.id, { admin: true });
    }
  });
}

// ── Favourites ───────────────────────────────────────────────────────────────

/** Pin a conversation (I hold a participant row in it) or an agent thread
 *  (an agent I may chat with); "not found" for any other. */
export async function setMessengerFavourite(
  actor: MessengerActor,
  kind: 'conversation' | 'agent',
  refId: string,
  rank = 0,
): Promise<void> {
  const ref = uuidOr(refId, 'The pin');
  if (kind !== 'conversation' && kind !== 'agent') {
    throw new InputError('A pin is a conversation or an agent.');
  }
  if (!Number.isSafeInteger(rank)) throw new InputError('rank is a whole number.');
  if (kind === 'conversation') {
    const [p] = await q<{ ok: number }>(
      systemDb,
      sql`select 1 as ok from messenger_participants p
            join messenger_conversations c on c.id = p.conversation_id
           where p.conversation_id = ${ref}::uuid and p.kind = 'login'
             and p.login_id = ${actor.loginId}::uuid and c.owner_id = ${actor.ownerId}::uuid`,
    );
    if (!p) throw new MessengerNotFoundError();
  } else {
    const agents = await messengerChatAgents(actor.ownerId, actor.loginId);
    if (!agents.some((a) => a.id === ref)) throw new MessengerNotFoundError('No such agent.');
  }
  await systemDb
    .insert(messengerFavourites)
    .values({ loginId: actor.loginId, kind, refId: ref, rank })
    .onConflictDoUpdate({
      target: [messengerFavourites.loginId, messengerFavourites.kind, messengerFavourites.refId],
      set: { rank },
    });
}

export async function removeMessengerFavourite(
  actor: MessengerActor,
  kind: 'conversation' | 'agent',
  refId: string,
): Promise<void> {
  const ref = uuidOr(refId, 'The pin');
  if (kind !== 'conversation' && kind !== 'agent') {
    throw new InputError('A pin is a conversation or an agent.');
  }
  await systemDb
    .delete(messengerFavourites)
    .where(
      and(
        eq(messengerFavourites.loginId, actor.loginId),
        eq(messengerFavourites.kind, kind),
        eq(messengerFavourites.refId, ref),
      ),
    );
}

// ── Reads (the login's scope: row security, and the login in every WHERE) ───

type MessageRow = {
  id: string;
  conversation_id: string;
  seq: string | number;
  author_kind: 'login' | 'agent' | 'system';
  author_login_id: string | null;
  author_agent_id: string | null;
  author_name: string | null;
  via: string | null;
  body: string;
  attachments: string[] | null;
  mentions: MessengerMention[] | null;
  reply_to_seq: string | number | null;
  client_msg_id: string | null;
  status: 'complete' | 'pending' | 'failed';
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
};

/** The window of seqs a login may see in a conversation: after its clear,
 *  up to its leave. The participant row, read in the login's scope. */
const MY_WINDOW = (loginId: string) => sql`
  join messenger_participants me
    on me.conversation_id = m.conversation_id and me.kind = 'login' and me.login_id = ${loginId}::uuid
   and m.seq > me.cleared_before_seq
   and (me.left_at is null or m.seq <= me.left_seq)`;

async function decorate(
  actor: MessengerActor,
  rows: MessageRow[],
): Promise<MessengerMessageView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const reactions = await q<{
    message_id: string;
    emoji: string;
    count: string | number;
    mine: boolean;
  }>(
    db,
    sql`select message_id::text as message_id, emoji, count(*) as count,
               bool_or(login_id = ${actor.loginId}::uuid) as mine
          from messenger_reactions where message_id = any(${uuidArray(ids)})
         group by message_id, emoji order by min(created_at)`,
  );
  const byMessage = new Map<string, MessengerMessageView['reactions']>();
  for (const r of reactions) {
    const list = byMessage.get(r.message_id) ?? [];
    list.push({ emoji: r.emoji, count: num(r.count), mine: r.mine === true });
    byMessage.set(r.message_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    seq: num(r.seq),
    authorKind: r.author_kind,
    authorId: r.author_login_id ?? r.author_agent_id ?? null,
    authorName: r.author_name,
    via: r.via,
    body: r.deleted_at ? '' : r.body,
    attachments: r.attachments ?? [],
    mentions: r.mentions ?? [],
    replyToSeq: numOrNull(r.reply_to_seq),
    clientMsgId: r.client_msg_id,
    status: r.status,
    editedAt: isoOrNull(r.edited_at),
    deletedAt: isoOrNull(r.deleted_at),
    createdAt: iso(r.created_at),
    reactions: byMessage.get(r.id) ?? [],
  }));
}

const MESSAGE_COLUMNS = sql`m.id::text as id, m.conversation_id::text as conversation_id, m.seq,
  m.author_kind, m.author_login_id::text as author_login_id, m.author_agent_id::text as author_agent_id,
  m.author_name, m.via, m.body, m.attachments, m.mentions, m.reply_to_seq, m.client_msg_id, m.status,
  m.edited_at, m.deleted_at, m.created_at`;

async function readMessagesBySeq(
  actor: MessengerActor,
  conversationId: string,
  seqs: readonly number[],
): Promise<MessengerMessageView[]> {
  const rows = await q<MessageRow>(
    db,
    sql`select ${MESSAGE_COLUMNS} from messenger_messages m ${MY_WINDOW(actor.loginId)}
         where m.conversation_id = ${conversationId}::uuid
           and m.seq = any(${`{${seqs.join(',')}}`}::bigint[])
         order by m.seq`,
  );
  return decorate(actor, rows);
}

export type MessengerPageInput = {
  beforeSeq?: number | null;
  afterSeq?: number | null;
  limit?: number | null;
  /** Leave out my own messages sent through this credential (a via_ref;
   *  null: those sent with none). Absent: keep them all. messenger_wait. */
  skipOwnVia?: string | null;
};

/**
 * GET /api/messenger/c/:id/messages: oldest first in the window.
 *  - neither cursor: the last `limit` (default 20);
 *  - before_seq: the `limit` below it (scrolling up);
 *  - after_seq: everything after it, `limit` at a time (the catch-up).
 */
export async function listMessengerMessages(
  actor: MessengerActor,
  conversationId: string,
  input: MessengerPageInput = {},
): Promise<{ messages: MessengerMessageView[]; lastSeq: number; hasMore: boolean }> {
  const c = uuidOr(conversationId, 'The conversation');
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? MESSENGER_PAGE_DEFAULT), 1),
    MESSENGER_PAGE_MAX,
  );
  const [conv] = await q<{ last_seq: string | number }>(
    db,
    sql`select c.last_seq from messenger_conversations c
          join messenger_participants me on me.conversation_id = c.id and me.kind = 'login'
                                        and me.login_id = ${actor.loginId}::uuid
         where c.id = ${c}::uuid and c.owner_id = ${actor.ownerId}::uuid`,
  );
  if (!conv) throw new MessengerNotFoundError();
  let rows: MessageRow[];
  if (input.afterSeq != null) {
    const after = seqOr(input.afterSeq, 'after_seq');
    const skip =
      input.skipOwnVia !== undefined
        ? sql`and not (m.author_kind = 'login' and m.author_login_id = ${actor.loginId}::uuid
                       and m.via_ref is not distinct from ${input.skipOwnVia})`
        : sql``;
    rows = await q<MessageRow>(
      db,
      sql`select ${MESSAGE_COLUMNS} from messenger_messages m ${MY_WINDOW(actor.loginId)}
           where m.conversation_id = ${c}::uuid and m.seq > ${after} ${skip}
           order by m.seq asc limit ${limit + 1}`,
    );
    const hasMore = rows.length > limit;
    return {
      messages: await decorate(actor, rows.slice(0, limit)),
      lastSeq: num(conv.last_seq),
      hasMore,
    };
  }
  const before = input.beforeSeq != null ? seqOr(input.beforeSeq, 'before_seq') : null;
  rows = await q<MessageRow>(
    db,
    sql`select ${MESSAGE_COLUMNS} from messenger_messages m ${MY_WINDOW(actor.loginId)}
         where m.conversation_id = ${c}::uuid ${before !== null ? sql`and m.seq < ${before}` : sql``}
         order by m.seq desc limit ${limit + 1}`,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return { messages: await decorate(actor, page), lastSeq: num(conv.last_seq), hasMore };
}

type ParticipantReadRow = {
  conversation_id: string;
  kind: 'login' | 'agent';
  id: string;
  admin: boolean;
  left_at: Date | null;
};

async function participantsOf(
  conversationIds: readonly string[],
): Promise<Map<string, MessengerParticipantView[]>> {
  const out = new Map<string, MessengerParticipantView[]>();
  if (conversationIds.length === 0) return out;
  const rows = await q<ParticipantReadRow>(
    db,
    sql`select conversation_id::text as conversation_id, kind,
               coalesce(login_id, agent_id)::text as id, admin, left_at
          from messenger_participants
         where conversation_id = any(${uuidArray(conversationIds)})
         order by joined_at, id`,
  );
  const [ln, an] = await Promise.all([
    loginNames([...new Set(rows.filter((r) => r.kind === 'login').map((r) => r.id))]),
    agentNames([...new Set(rows.filter((r) => r.kind === 'agent').map((r) => r.id))]),
  ]);
  for (const r of rows) {
    const list = out.get(r.conversation_id) ?? [];
    list.push({
      kind: r.kind,
      id: r.id,
      name: (r.kind === 'login' ? ln.get(r.id) : an.get(r.id)) ?? 'Someone',
      admin: r.admin,
      leftAt: isoOrNull(r.left_at),
    });
    out.set(r.conversation_id, list);
  }
  return out;
}

/** GET /api/messenger/c/:id: one conversation, its participants and my row. */
export async function getMessengerConversation(
  actor: MessengerActor,
  conversationId: string,
): Promise<MessengerConversationView> {
  const c = uuidOr(conversationId, 'The conversation');
  const [row] = await q<{
    id: string;
    kind: 'direct' | 'group';
    title: string | null;
    created_by: string | null;
    created_at: Date;
    archived_at: Date | null;
    last_seq: string | number;
    last_message_at: Date | null;
    workspace_id: string | null;
    agent_id: string | null;
    admin: boolean;
    last_read_seq: string | number;
    cleared_before_seq: string | number;
    muted: boolean;
    left_seq: string | number | null;
  }>(
    db,
    sql`select c.id::text as id, c.kind, c.title, c.created_by::text as created_by, c.created_at,
               c.archived_at, c.last_seq, c.last_message_at, c.workspace_id::text as workspace_id,
               c.agent_id::text as agent_id, me.admin, me.last_read_seq, me.cleared_before_seq, me.muted,
               me.left_seq
          from messenger_conversations c
          join messenger_participants me on me.conversation_id = c.id and me.kind = 'login'
                                        and me.login_id = ${actor.loginId}::uuid
         where c.id = ${c}::uuid and c.owner_id = ${actor.ownerId}::uuid`,
  );
  if (!row) throw new MessengerNotFoundError();
  const parts = (await participantsOf([row.id])).get(row.id) ?? [];
  return {
    id: row.id,
    kind: row.kind,
    title: row.kind === 'direct' ? null : row.title,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    archivedAt: isoOrNull(row.archived_at),
    lastSeq: num(row.last_seq),
    lastMessageAt: isoOrNull(row.last_message_at),
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    participants: parts,
    me: {
      admin: row.admin,
      lastReadSeq: num(row.last_read_seq),
      clearedBeforeSeq: num(row.cleared_before_seq),
      muted: row.muted,
      leftSeq: numOrNull(row.left_seq),
    },
  };
}

/** A conversation's shown title: a group's own, else the other people. */
function titleFor(
  kind: 'direct' | 'group',
  title: string | null,
  parts: MessengerParticipantView[],
  loginId: string,
): string {
  if (kind === 'group' && title) return title;
  const others = parts.filter((p) => !(p.kind === 'login' && p.id === loginId) && !p.leftAt);
  if (others.length === 0) return kind === 'group' ? 'Just you' : 'Chat';
  return others.map((p) => p.name).join(', ');
}

type ListRow = {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  last_seq: string | number;
  last_message_at: Date | null;
  last_preview: MessengerPreviewView | null;
  muted: boolean;
  unread: string | number;
  mention: boolean;
  favourite: boolean;
  fav_rank: number | null;
};

/** My people chats and groups with their unread arithmetic (plan section
 *  8): last seq I may read minus the greater of my read cursor and my clear,
 *  never below zero. */
async function myConversationRows(actor: MessengerActor, unreadOnly = false): Promise<ListRow[]> {
  return q<ListRow>(
    db,
    sql`select c.id::text as id, c.kind, c.title, c.last_seq, c.last_message_at, c.last_preview, me.muted,
               greatest(0, least(c.last_seq, coalesce(me.left_seq, c.last_seq))
                           - greatest(me.last_read_seq, me.cleared_before_seq)) as unread,
               me.mention_seq > greatest(me.last_read_seq, me.cleared_before_seq) as mention,
               f.login_id is not null as favourite, f.rank as fav_rank
          from messenger_participants me
          join messenger_conversations c on c.id = me.conversation_id
          left join messenger_favourites f
            on f.login_id = me.login_id and f.kind = 'conversation' and f.ref_id = c.id
         where me.kind = 'login' and me.login_id = ${actor.loginId}::uuid
           and c.owner_id = ${actor.ownerId}::uuid
           ${unreadOnly ? sql`and c.last_seq > greatest(me.last_read_seq, me.cleared_before_seq)` : sql``}`,
  );
}

type AgentThreadRow = {
  agent_id: string;
  slug: string;
  name: string;
  last_at: Date | null;
  last_text: string | null;
  last_direction: 'inbound' | 'outbound' | null;
  unread: string | number;
  favourite: boolean;
  fav_rank: number | null;
};

/** My agent threads (assistant_messages, plan section 5): each agent I may
 *  chat with that has a thread with me or that I pinned, with the replies
 *  after my read cursor as unread. My own rows only (login_id). */
async function myAgentThreadRows(actor: MessengerActor): Promise<AgentThreadRow[]> {
  const agents = await messengerChatAgents(actor.ownerId, actor.loginId);
  if (agents.length === 0) return [];
  const ids = agents.map((a) => a.id);
  const rows = await q<{
    agent_id: string;
    last_at: Date | null;
    last_text: string | null;
    last_direction: 'inbound' | 'outbound' | null;
    unread: string | number;
  }>(
    systemDb,
    sql`select a.id::text as agent_id, last.created_at as last_at, last.text as last_text,
               last.direction as last_direction,
               (select count(*) from assistant_messages u
                 where u.owner_id = ${actor.ownerId}::uuid and u.agent_id = a.id
                   and u.login_id = ${actor.loginId}::uuid and u.direction = 'outbound'
                   and u.created_at > coalesce(
                     (select r.last_read_at from assistant_read_cursors r
                       where r.owner_id = ${actor.ownerId}::uuid and r.agent_id = a.id
                         and r.login_id = ${actor.loginId}::uuid), 'epoch'::timestamptz)) as unread
          from unnest(${uuidArray(ids)}) as a(id)
          left join lateral (
            select m.created_at, m.text, m.direction from assistant_messages m
             where m.owner_id = ${actor.ownerId}::uuid and m.agent_id = a.id
               and m.login_id = ${actor.loginId}::uuid
             order by m.created_at desc limit 1) last on true`,
  );
  const favs = await q<{ ref_id: string; rank: number }>(
    systemDb,
    sql`select ref_id::text as ref_id, rank from messenger_favourites
         where login_id = ${actor.loginId}::uuid and kind = 'agent'`,
  );
  const fav = new Map(favs.map((f) => [f.ref_id, f.rank]));
  const meta = new Map(agents.map((a) => [a.id, a]));
  return rows
    .filter((r) => r.last_at || fav.has(r.agent_id))
    .map((r) => ({
      ...r,
      slug: meta.get(r.agent_id)!.slug,
      name: meta.get(r.agent_id)!.name,
      favourite: fav.has(r.agent_id),
      fav_rank: fav.get(r.agent_id) ?? null,
    }));
}

/**
 * GET /api/messenger/conversations: one list of people chats, groups and
 * agent threads. Favourites first (by rank), then the newest last message
 * first. `unreadOnly` keeps the rows with something unread.
 */
export async function listMessengerConversations(
  actor: MessengerActor,
  opts: { unreadOnly?: boolean } = {},
): Promise<MessengerListRowView[]> {
  const [convs, threads] = await Promise.all([
    myConversationRows(actor, opts.unreadOnly === true),
    myAgentThreadRows(actor),
  ]);
  const parts = await participantsOf(convs.map((c) => c.id));
  const rows: (MessengerListRowView & { rank: number | null })[] = [
    ...convs.map((c) => {
      const ps = parts.get(c.id) ?? [];
      return {
        kind: c.kind,
        id: c.id,
        title: titleFor(c.kind, c.title, ps, actor.loginId),
        lastSeq: num(c.last_seq),
        lastMessageAt: isoOrNull(c.last_message_at),
        preview: c.last_preview,
        unread: num(c.unread),
        mention: c.mention === true,
        muted: c.muted,
        favourite: c.favourite === true,
        participants: ps,
        rank: c.fav_rank,
      };
    }),
    ...threads
      .filter((t) => !opts.unreadOnly || num(t.unread) > 0)
      .map((t) => ({
        kind: 'agent' as const,
        id: t.agent_id,
        title: t.name,
        lastSeq: null,
        lastMessageAt: isoOrNull(t.last_at),
        preview: t.last_text
          ? {
              authorName: t.last_direction === 'outbound' ? t.name : null,
              text: previewOf(t.last_text),
              authorKind: (t.last_direction === 'outbound' ? 'agent' : 'login') as
                'agent' | 'login',
            }
          : null,
        unread: num(t.unread),
        mention: false,
        muted: false,
        favourite: t.favourite,
        participants: [],
        agentSlug: t.slug,
        rank: t.fav_rank,
      })),
  ];
  rows.sort((a, b) => {
    if (a.favourite !== b.favourite) return a.favourite ? -1 : 1;
    if (a.favourite && b.favourite && (a.rank ?? 0) !== (b.rank ?? 0))
      return (a.rank ?? 0) - (b.rank ?? 0);
    const at = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
    const bt = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
    return bt - at;
  });
  return rows.map(({ rank: _rank, ...r }) => r);
}

/** GET /api/messenger/unread: the badge. People chats and groups (unmuted
 *  rows count too: muted chats count but never pop, plan section 8) plus
 *  the agent threads' replies after my cursor. */
export async function messengerUnread(
  actor: MessengerActor,
): Promise<{ total: number; messenger: number; agents: number }> {
  const [row] = await q<{ n: string | number | null }>(
    db,
    sql`select sum(greatest(0, least(c.last_seq, coalesce(me.left_seq, c.last_seq))
                               - greatest(me.last_read_seq, me.cleared_before_seq))) as n
          from messenger_participants me
          join messenger_conversations c on c.id = me.conversation_id
         where me.kind = 'login' and me.login_id = ${actor.loginId}::uuid
           and c.owner_id = ${actor.ownerId}::uuid`,
  );
  const messenger = num(row?.n ?? 0);
  const threads = await myAgentThreadRows(actor);
  const agents = threads.reduce((s, t) => s + num(t.unread), 0);
  return { total: messenger + agents, messenger, agents };
}

// ── The stream's fan-out (system pool) ───────────────────────────────────────

/** The logins that hold a participant row in a conversation, with the seq
 *  a left one reads up to (null: live), for the SSE fan-out of section 7
 *  (server/web/lib/realtime.ts filters each event by it). On the system
 *  pool: the stream's listener holds no scope. */
export async function messengerParticipantLogins(
  conversationId: string,
): Promise<{ loginId: string; leftSeq: number | null }[]> {
  if (!isUuid(conversationId)) return [];
  const rows = await q<{ login_id: string; left_seq: string | number | null }>(
    systemDb,
    sql`select login_id::text as login_id, left_seq from messenger_participants
         where conversation_id = ${conversationId}::uuid and kind = 'login'`,
  );
  return rows.map((r) => ({ loginId: r.login_id, leftSeq: numOrNull(r.left_seq) }));
}

/** Whether a login may still use the messenger: it exists, has a mailbox
 *  and is not disabled. The stream asks on every heartbeat (a disabled
 *  login's stream closes). On the system pool: a viewer role reads no
 *  auth.users row. */
export async function messengerLoginUsable(loginId: string): Promise<boolean> {
  if (!isUuid(loginId)) return false;
  const [r] = await q<{ ok: boolean }>(
    systemDb,
    sql`select (email is not null and disabled_at is null) as ok from auth.users where id = ${loginId}::uuid`,
  );
  return r?.ok === true;
}

/** Mark a login active for "online" (the stream's heartbeat): at most one
 *  write a minute per login. */
export async function touchLoginPresence(loginId: string): Promise<void> {
  await systemDb
    .insert(loginPresence)
    .values({ loginId })
    .onConflictDoUpdate({
      target: loginPresence.loginId,
      set: { lastActiveAt: sql`now()` },
      setWhere: sql`${loginPresence.lastActiveAt} < now() - interval '1 minute'`,
    });
}

/** Raise a typing event (plan section 7): a NOTIFY, stored nowhere. Only a
 *  live participant's. */
export async function messengerTyping(
  actor: MessengerActor,
  conversationId: string,
): Promise<void> {
  const c = uuidOr(conversationId, 'The conversation');
  const [p] = await q<{ ok: number }>(
    db,
    sql`select 1 as ok from messenger_participants
         where conversation_id = ${c}::uuid and kind = 'login'
           and login_id = ${actor.loginId}::uuid and left_at is null`,
  );
  if (!p) throw new MessengerNotFoundError();
  await systemDb.execute(
    sql`select pg_notify('messenger_changed', ${JSON.stringify({ c, seq: null, kind: 'typing', actor: actor.loginId })})`,
  );
}

/** The hand-run drift check of section 11: conversations whose last_seq is
 *  not the max seq of their messages (history deletes leave max below it,
 *  which is fine; a max ABOVE last_seq is a bug). */
export const MESSENGER_SEQ_DRIFT_SQL = `select c.id, c.last_seq, max(m.seq) as max_seq
  from messenger_conversations c join messenger_messages m on m.conversation_id = c.id
 group by c.id, c.last_seq having max(m.seq) > c.last_seq`;

// ── The via label (plan section 6, section 20 item 3) ────────────────────────

/** The label and ref of the credential an MCP call came through: the OAuth
 *  client's name, the API key's name, the peer's name. Read on the system
 *  pool. Null when the call names no credential (a session). */
export async function messengerViaFor(cred: {
  oauthClientId?: string | null;
  keyId?: string | null;
  peerId?: string | null;
}): Promise<MessengerVia | null> {
  if (cred.keyId && isUuid(cred.keyId)) {
    const [r] = await q<{ name: string | null }>(
      systemDb,
      sql`select name from access_keys where id = ${cred.keyId}::uuid`,
    );
    return { label: r?.name ?? 'API key', ref: `key:${cred.keyId}` };
  }
  if (cred.peerId && isUuid(cred.peerId)) {
    const [r] = await q<{ name: string | null }>(
      systemDb,
      sql`select display_name as name from mantle_peers where id = ${cred.peerId}::uuid`,
    );
    return { label: r?.name ?? 'Peer', ref: `peer:${cred.peerId}` };
  }
  if (cred.oauthClientId) {
    const [r] = await q<{ name: string | null }>(
      systemDb,
      sql`select client_name as name from oauth_clients where id::text = ${cred.oauthClientId}`,
    );
    return { label: r?.name ?? 'MCP', ref: `oauth:${cred.oauthClientId}` };
  }
  return null;
}

// ── Wait (messenger_wait, plan sections 6 and 12) ────────────────────────────

/** messenger_wait's longest wait. */
export const MESSENGER_WAIT_MAX_MS = 60_000;

type Listener = (payload: { c: string; seq: number | null; kind: string }) => void;
const waitListeners = new Set<Listener>();
let listening: Promise<void> | null = null;
/** One open wait per credential (plan section 14): a new wait from the
 *  same credential ends the older one with nothing. */
const openWaits = new Map<string, () => void>();

/** One LISTEN on messenger_changed per process, made on the first wait. A
 *  failed LISTEN leaves the wait to its poll. */
function ensureWaitListener(): Promise<void> {
  listening ??= (async () => {
    const client = (
      systemDb as unknown as {
        $client: { listen: (ch: string, cb: (p: string) => void) => Promise<unknown> };
      }
    ).$client;
    await client.listen('messenger_changed', (raw) => {
      try {
        const p = JSON.parse(raw) as { c?: string; seq?: number | string | null; kind?: string };
        if (!p.c || !p.kind) return;
        const payload = { c: p.c, seq: p.seq == null ? null : num(p.seq), kind: p.kind };
        for (const l of waitListeners) l(payload);
      } catch {
        /* a malformed payload: drop it */
      }
    });
  })().catch(() => {
    // No LISTEN (a database that refused it): every wait polls every 5 s,
    // and the next wait tries the LISTEN again.
    listening = null;
  });
  return listening;
}

/**
 * Wait for new messages in a conversation after `afterSeq` (messenger_wait).
 * Answers at once when there are some, else on the first new message (a
 * NOTIFY, checked again every 5 s), else empty at the timeout (60 s at
 * most). Messages sent through the caller's own credential (via_ref; a
 * session's own null) are skipped: two clients on one login wait for each
 * other (decision 19.3). Every check runs here, in the caller's own scope:
 * the LISTEN callback only wakes it.
 */
export async function waitForMessengerMessages(
  actor: MessengerActor,
  conversationId: string,
  afterSeq: number,
  timeoutMs: number,
): Promise<{ messages: MessengerMessageView[]; lastSeq: number; timedOut: boolean }> {
  const c = uuidOr(conversationId, 'The conversation');
  const after = seqOr(afterSeq, 'after_seq');
  const wait = Math.min(Math.max(Math.trunc(timeoutMs), 0), MESSENGER_WAIT_MAX_MS);
  const check = () =>
    listMessengerMessages(actor, c, {
      afterSeq: after,
      limit: MESSENGER_PAGE_MAX,
      skipOwnVia: actor.via?.ref ?? null,
    });

  const first = await check();
  if (first.messages.length > 0 || wait === 0) {
    return {
      messages: first.messages,
      lastSeq: first.lastSeq,
      timedOut: first.messages.length === 0,
    };
  }

  const key = `${actor.loginId}|${actor.via?.ref ?? 'session'}`;
  openWaits.get(key)?.();
  let cancelled = false;
  let wake: (() => void) | null = null;
  const cancel = () => {
    cancelled = true;
    wake?.();
  };
  const onEvent: Listener = (p) => {
    if (p.c === c && (p.kind === 'new' || p.kind === 'edit')) wake?.();
  };
  openWaits.set(key, cancel);
  waitListeners.add(onEvent);
  try {
    await ensureWaitListener();
    const deadline = Date.now() + wait;
    let lastSeq = first.lastSeq;
    while (!cancelled) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 5000));
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
      if (cancelled) break;
      const got = await check();
      lastSeq = got.lastSeq;
      if (got.messages.length > 0) return { messages: got.messages, lastSeq, timedOut: false };
    }
    return { messages: [], lastSeq, timedOut: true };
  } finally {
    waitListeners.delete(onEvent);
    if (openWaits.get(key) === cancel) openWaits.delete(key);
  }
}
