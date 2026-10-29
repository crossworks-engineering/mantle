/**
 * The messenger: direct chats and groups between the logins of one brain.
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
 *  - Nothing here starts LLM work: a mention is stored and enqueues
 *    nothing, and no trigger spends.
 *  - Every write takes the login's budget here (takeBudget), where the
 *    routes and the MCP tools meet: one bucket per login, whichever path
 *    the call came by.
 */
import { and, eq, inArray, isNull, lt, lte, sql, type SQL } from 'drizzle-orm';
import { envNum } from '@mantle/config';
import {
  currentWorkspaceScope,
  db,
  loginPresence,
  messengerCallParticipants,
  messengerConversations,
  messengerFavourites,
  messengerMessages,
  messengerParticipants,
  messengerReactions,
  systemDb,
  type MessengerEventJson,
} from '@mantle/db';
import { InputError, defineDomainError, isUuid } from '@mantle/std';
import { callsServiceOn, livekitClient, loginIdentity } from './livekit';
import {
  PEOPLE_ONLINE_MS,
  agentFaces,
  loginFaces,
  loginIsAdmin,
  loginVisibleTo,
  peopleVisibleTo,
  roomPeopleSql,
  type PersonAvatarView,
} from './people';
import { APP_TINTS, LUCIDE_ICON_PREFIX, isAppTint } from '@mantle/client-types/app-nav';
import { projectAppIcon } from '@mantle/content-core/app-nav';
import { workspaceAssistants } from './team-assistant';

// ── Limits ───────────────────────────────────────────────────────────────────

export const MESSENGER_BODY_MAX = 8000;
export const MESSENGER_PARTICIPANTS_MAX = 200;
export const MESSENGER_TITLE_MAX = 200;
/** A group's info (0343): what it is for and its rules. */
export const MESSENGER_INFO_MAX = 2000;
export const MESSENGER_PAGE_DEFAULT = 20;
export const MESSENGER_PAGE_MAX = 100;
export const MESSENGER_PREVIEW_CHARS = 140;
export const MESSENGER_CLIENT_MSG_MAX = 100;
export const MESSENGER_EMOJI_MAX = 32;
/** "Online": active within this long (the people module's). */
export const MESSENGER_ONLINE_MS = PEOPLE_ONLINE_MS;
/** Roles that hold a back-and-forth chat (mirrors listAssistantAgents). */
const CHATTABLE_ROLES = ['assistant', 'responder', 'custom'] as const;

/** A login's budget a minute: sends, and every other
 *  write (a create, a read cursor, an edit, membership, pins). The routes'
 *  gate takes its own limits as well (server/web/lib/route-limits.ts,
 *  the same numbers); this one is the bucket an MCP call and a route
 *  share. */
export const MESSENGER_SENDS_PER_MIN = 60;
export const MESSENGER_WRITES_PER_MIN = 120;
const BUDGET_WINDOW_MS = 60_000;

// ── Errors ───────────────────────────────────────────────────────────────────

/** No such conversation or message for this login: also what a
 *  non-participant hears, so an outsider learns nothing. */
export class MessengerNotFoundError extends Error {
  constructor(message = 'Conversation not found (or you are not in it).') {
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

/** A login spent its messenger budget for this minute (sends or writes). */
export class MessengerRateLimitedError extends Error {
  constructor(readonly retryAfterSec: number) {
    super(`Too many messenger writes from this login. Try again in ${retryAfterSec} s.`);
    this.name = 'MessengerRateLimitedError';
  }
}
defineDomainError(MessengerRateLimitedError, {
  reason: 'a login spent its messenger budget for the minute; the message says when to try again',
  status: 429,
});

// ── The budget ───────────────────────────────────────────────────────────────

type BudgetKind = 'send' | 'write';
/** A fixed window per login and kind, in this process (as the routes' own
 *  limiter, server/web/lib/rate-limit.ts). Its keys are login ids, so the
 *  map is bounded by the logins of the brain. */
const budgets = new Map<string, { count: number; start: number }>();
/** The e2e stack's factor (MANTLE_RATE_LIMIT_SCALE), as the routes'. */
const BUDGET_SCALE = envNum('MANTLE_RATE_LIMIT_SCALE');

export function takeBudget(actor: MessengerActor, kind: BudgetKind): void {
  const max = (kind === 'send' ? MESSENGER_SENDS_PER_MIN : MESSENGER_WRITES_PER_MIN) * BUDGET_SCALE;
  const key = `${kind}:${actor.loginId.toLowerCase()}`;
  const now = Date.now();
  let b = budgets.get(key);
  if (!b || now - b.start >= BUDGET_WINDOW_MS) {
    if (budgets.size >= 10_000) {
      for (const [k, v] of budgets) if (now - v.start >= BUDGET_WINDOW_MS) budgets.delete(k);
    }
    b = { count: 0, start: now };
    budgets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) {
    throw new MessengerRateLimitedError(
      Math.max(1, Math.ceil((b.start + BUDGET_WINDOW_MS - now) / 1000)),
    );
  }
}

/** Tests only: start every login's budget again. */
export function resetMessengerBudgetsForTests(): void {
  budgets.clear();
}

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

/** The avatar a login chose in Appearance (its seed and builder parts) or
 *  an agent's, drawn in the brain's one style; the shape GET /api/shell
 *  gives for the caller's own. */
export type MessengerAvatarView = PersonAvatarView;

export type MessengerParticipantView = {
  kind: 'login' | 'agent';
  id: string;
  name: string;
  admin: boolean;
  leftAt: string | null;
  /** null: the client draws initials. */
  avatar?: MessengerAvatarView | null;
  /** A login's uploaded photo (GET /api/messenger/photo/:loginId?v=); null
   *  when it has none. Logins only. */
  photoVersion?: string | null;
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
  /** A group's icon (an emoji) and colour (an app tint key); null for a
   *  direct chat and a group that has none (0341). */
  icon?: string | null;
  color?: string | null;
  /** A group's info (0343): plain text its admins wrote, shown and never
   *  run; null for a direct chat and a group that has none. */
  info: string | null;
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
  /** What a system line marks (a call, 0342); null on every other row. */
  event: MessengerEventJson | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  reactions: { emoji: string; count: number; mine: boolean }[];
};

export type MessengerListRowView = {
  kind: 'direct' | 'group' | 'agent';
  id: string;
  title: string;
  /** As on the conversation; absent on an agent thread. */
  icon?: string | null;
  color?: string | null;
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
  avatar?: MessengerAvatarView | null;
  /** Logins only, as on a participant. */
  photoVersion?: string | null;
};

// ── Small helpers ────────────────────────────────────────────────────────────

type Exec = { execute: (q: SQL) => Promise<unknown> };

export async function q<T>(on: Exec, query: SQL): Promise<T[]> {
  return (await on.execute(query)) as unknown as T[];
}

/** A bigint from the driver (a string) or a number, as a number. */
export function num(v: unknown): number {
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
  if (!isUuid(v)) throw new InputError(`${what} must be an id (a uuid).`);
  return v.toLowerCase();
}

function seqOr(v: number, what: string): number {
  if (!Number.isSafeInteger(v) || v < 0)
    throw new InputError(`${what} must be a sequence number (a whole number, 0 or more).`);
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
 *  system pool, or on `on`: inside a write's transaction always its own
 *  connection (a second one, under many concurrent sends, empties the
 *  pool). */
export async function loginNames(
  ids: readonly string[],
  on: Exec = systemDb,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await q<{ id: string; name: string }>(
    on,
    sql`select id::text as id,
               coalesce(nullif(btrim(display_name), ''), split_part(coalesce(email, ''), '@', 1), 'User') as name
          from auth.users where id = any(${uuidArray(ids)})`,
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Whether a login is an Admin user (a user of the live Admin workspace). */
export const messengerIsAdmin = loginIsAdmin;

// ── Who may see whom: the people module ─────────────────────────────────────
//
// The one gate of every person-to-person read is packages/content/src/
// people.ts (peopleVisibleTo: the directory, who may start a chat with or
// be added by whom; loginVisibleTo: the whole rule for one login). The
// messenger's lists apply it in their own one query (the directory reads
// peopleVisibleTo, a room's people PEOPLE, whose rule people.ts holds too),
// and their faces are filled only for the logins those return.

export { loginVisibleTo, peopleVisibleTo };

/**
 * The agents a login may chat with: the assistant of
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
               and role::text = any(${`{${CHATTABLE_ROLES.join(',')}}`}::text[])
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
  const [people, chatAgents] = await Promise.all([
    peopleVisibleTo(actor, { q: term || undefined }),
    messengerChatAgents(actor.ownerId, actor.loginId),
  ]);
  const t = term.toLowerCase();
  const agents = chatAgents.filter(
    (a) => !t || a.name.toLowerCase().includes(t) || a.slug.toLowerCase().includes(t),
  );
  const faces = await agentFaces(
    actor.ownerId,
    agents.map((a) => a.id),
  );
  return [
    ...people.map((p) => ({
      kind: 'login' as const,
      id: p.id,
      name: p.name,
      online: !!p.lastActiveAt && now - p.lastActiveAt.getTime() < MESSENGER_ONLINE_MS,
      avatar: p.avatar,
      photoVersion: p.photoVersion,
    })),
    ...agents.map((a) => ({
      kind: 'agent' as const,
      id: a.id,
      name: a.name,
      online: false,
      slug: a.slug,
      avatar: faces.get(a.id)?.avatar ?? null,
    })),
  ];
}

// ── Participant checks (system pool, inside the write's transaction) ─────────
// lockForActor, lockConversation, appendMessage, loginNames, requireGroupAdmin
// and takeBudget are exported for messenger-calls.ts only: a call is a fact
// of a conversation and takes its seq and its participant rule from here.

export type Tx = Parameters<Parameters<typeof systemDb.transaction>[0]>[0];

export type ParticipantRow = {
  id: string;
  admin: boolean;
  left_at: Date | null;
  left_seq: string | number | null;
  last_read_seq: string | number;
  cleared_before_seq: string | number;
  from_seq: string | number;
  muted: boolean;
};

export type ConversationRow = {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  info: string | null;
  archived_at: Date | null;
  last_seq: string | number;
  workspace_id: string | null;
  agent_id: string | null;
};

/** Lock the conversation and read the actor's participant row; "not found"
 *  for a login that holds none (or a conversation of another brain). */
export async function lockForActor(
  tx: Tx,
  actor: MessengerActor,
  conversationId: string,
  opts: { live: boolean } = { live: true },
): Promise<{ conv: ConversationRow; me: ParticipantRow }> {
  const c = uuidOr(conversationId, 'The conversation');
  const [conv] = await q<ConversationRow>(
    tx,
    sql`select id::text as id, kind, title, info, archived_at, last_seq,
               workspace_id::text as workspace_id, agent_id::text as agent_id
          from messenger_conversations
         where id = ${c}::uuid and owner_id = ${actor.ownerId}::uuid
         for update`,
  );
  if (!conv) throw new MessengerNotFoundError();
  const [me] = await q<ParticipantRow>(
    tx,
    sql`select id::text as id, admin, left_at, left_seq, last_read_seq, cleared_before_seq, from_seq, muted
          from messenger_participants
         where conversation_id = ${c}::uuid and kind = 'login' and login_id = ${actor.loginId}::uuid`,
  );
  if (!me) throw new MessengerNotFoundError();
  if (opts.live && me.left_at) throw new MessengerRefusedError('You left this chat.');
  return { conv, me };
}

/** Lock a conversation with no actor (the webhook handler and the
 *  reconciler, which act for the room, not a login); null when it is not
 *  there. */
export async function lockConversation(
  tx: Tx,
  conversationId: string,
): Promise<ConversationRow | null> {
  const [conv] = await q<ConversationRow>(
    tx,
    sql`select id::text as id, kind, title, info, archived_at, last_seq,
               workspace_id::text as workspace_id, agent_id::text as agent_id
          from messenger_conversations
         where id = ${conversationId}::uuid
         for update`,
  );
  return conv ?? null;
}

export function requireGroupAdmin(conv: ConversationRow, me: ParticipantRow): void {
  if (conv.kind !== 'group') throw new MessengerRefusedError('A direct chat has no admin.');
  if (!me.admin) throw new MessengerRefusedError('Only a group admin may do that.');
}

/** A login that leaves the chat, or is removed from it, is out of the
 *  chat's open call too (the gate holds for the room): its open stay closes here, in the same transaction, and the
 *  caller tells the room after commit (dropFromRoom). Answers the room's
 *  name when the chat has an open call, else null. */
async function dropFromOpenCall(
  tx: Tx,
  conversationId: string,
  loginId: string,
): Promise<string | null> {
  const [call] = await q<{ id: string; room_name: string }>(
    tx,
    sql`select id::text as id, room_name from messenger_calls
         where conversation_id = ${conversationId}::uuid and ended_at is null
         for update`,
  );
  if (!call) return null;
  await tx
    .update(messengerCallParticipants)
    .set({ leftAt: sql`now()` })
    .where(
      and(
        eq(messengerCallParticipants.callId, call.id),
        eq(messengerCallParticipants.kind, 'login'),
        eq(messengerCallParticipants.loginId, loginId),
        isNull(messengerCallParticipants.leftAt),
      ),
    );
  return call.room_name;
}

/** After commit: the room drops the identity (best effort; the reconciler
 *  is the backstop). */
async function dropFromRoom(room: string | null, loginId: string): Promise<void> {
  if (!room || !callsServiceOn()) return;
  await livekitClient()
    .removeParticipant(room, loginIdentity(loginId))
    .catch(() => {});
}

/** Insert one message at last_seq + 1 and move the conversation's
 *  counters, in the caller's transaction (the conversation row is locked).
 *  The one place a seq is taken. */
export async function appendMessage(
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
    /** What a system line marks (a call event, 0342); null on every
     *  ordinary row. */
    event?: MessengerEventJson | null;
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
    event: m.event ?? null,
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

// ── Create ───────────────────────────────────────────────────────────────────

export type MessengerCreateInput = {
  kind: 'direct' | 'group';
  /** Login ids besides the actor. */
  participants: readonly string[];
  title?: string | null;
  /** A group's look (a direct chat ignores both): lookIcon, lookColor. */
  icon?: string | null;
  color?: string | null;
  /** A group's info (infoText); a direct chat refuses it (InputError). */
  info?: string | null;
};

/** A group's info as given: trimmed, at most MESSENGER_INFO_MAX
 *  characters; null, or blank, clears it; undefined leaves it. Longer is an
 *  InputError. Text only: nothing here reads it as markup or code. */
function infoText(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new InputError('info is text.');
  const t = v.trim();
  if (!t) return null;
  if (t.length > MESSENGER_INFO_MAX) {
    throw new InputError(`A group's info is at most ${MESSENGER_INFO_MAX} characters.`);
  }
  return t;
}

/** One emoji of Unicode's recommended set (RGI: a pictograph, a flag, a
 *  skin tone or a joined sequence such as a family), the whole string. A
 *  constructed RegExp: the `v` flag is newer than the compile target. */
const RGI_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');

/** Whether `v` is one emoji (RGI_EMOJI), or one a text-style character
 *  becomes with the emoji presentation selector (a bare heart). Nothing
 *  else: no letter, no second emoji, no joined chain of separate ones, no
 *  hidden tag text, no stacked mark, no control. */
function oneEmoji(v: string): boolean {
  return RGI_EMOJI.test(v) || RGI_EMOJI.test(`${v}\ufe0f`);
}

/** A group's icon as given: one emoji (oneEmoji, within the app-nav emoji
 *  rule: at most 16 characters); null, or '', clears it; undefined leaves
 *  it. Anything else is an InputError. */
function lookIcon(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const t = (v ?? '').trim();
  if (!t) return null;
  const icon = projectAppIcon(t);
  if (!icon || icon.startsWith(LUCIDE_ICON_PREFIX) || !oneEmoji(icon)) {
    throw new InputError('An icon is one emoji (at most 16 characters).');
  }
  return icon;
}

/** A group's colour as given: an app tint key (APP_TINTS); null, or '',
 *  clears it; undefined leaves it. Anything else is an InputError. */
function lookColor(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!isAppTint(v)) throw new InputError(`A colour is one of: ${APP_TINTS.join(', ')}.`);
  return v;
}

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
  takeBudget(actor, 'write');
  if (input.kind !== 'direct' && input.kind !== 'group') {
    throw new InputError('kind must be "direct" or "group".');
  }
  const self = actor.loginId.toLowerCase();
  const others = [...new Set(input.participants.map((p) => uuidOr(p, 'A participant')))].filter(
    (p) => p !== self,
  );
  if (input.kind === 'direct' && others.length !== 1) {
    throw new InputError('A direct chat must name exactly one other person (one login id).');
  }
  if (others.length + 1 > MESSENGER_PARTICIPANTS_MAX) {
    throw new InputError(`A group holds at most ${MESSENGER_PARTICIPANTS_MAX} people.`);
  }
  const title = input.kind === 'group' ? (input.title ?? '').trim() || null : null;
  if (title && title.length > MESSENGER_TITLE_MAX) {
    throw new InputError(`A title is at most ${MESSENGER_TITLE_MAX} characters.`);
  }
  const icon = input.kind === 'group' ? (lookIcon(input.icon) ?? null) : null;
  const color = input.kind === 'group' ? (lookColor(input.color) ?? null) : null;
  // A direct chat has no info (the table's check holds the same): a create
  // that gives one is refused, not quietly dropped.
  const info = infoText(input.info) ?? null;
  if (info !== null && input.kind !== 'group') {
    throw new InputError('A direct chat has no info; only a group carries one.');
  }
  if (others.length > 0) {
    const reach = await peopleVisibleTo(actor, { only: others, limit: 500 });
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
      .values({ ownerId: actor.ownerId, kind: 'group', title, icon, color, info, createdBy: self })
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
 * (no agent turn). The author's own read cursor moves to the new
 * seq.
 */
export async function sendMessengerMessage(
  actor: MessengerActor,
  conversationId: string,
  input: MessengerSendInput,
): Promise<{ message: MessengerMessageView; created: boolean }> {
  takeBudget(actor, 'send');
  const body = typeof input.body === 'string' ? input.body : '';
  if (body.trim() === '') throw new InputError('A message must have some text.');
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
      throw new InputError('reply_to_seq must be the seq of a message in this chat.');
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
          throw new InputError('A mention must name someone in this chat.');
        }
      }
    }
    const names = await loginNames([self], tx);
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
    if (num(me.last_read_seq) < seq)
      await tx
        .update(messengerParticipants)
        .set({ lastReadSeq: seq })
        .where(eq(messengerParticipants.id, me.id));
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
      throw new InputError('A mention must be a login or an agent.');
    }
    const id = uuidOr(String(m.id), 'A mention');
    const k = `${m.kind}:${id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind: m.kind, id });
  }
  if (out.length > MESSENGER_PARTICIPANTS_MAX)
    throw new InputError(`A message must mention at most ${MESSENGER_PARTICIPANTS_MAX} people.`);
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
  if (!m) throw new MessengerNotFoundError('Message not found in this chat.');
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
  takeBudget(actor, 'write');
  const s = seqOr(seq, 'seq');
  if (typeof body !== 'string' || body.trim() === '') {
    throw new InputError('A message must have some text.');
  }
  if (body.length > MESSENGER_BODY_MAX) {
    throw new InputError(`A message is at most ${MESSENGER_BODY_MAX} characters.`);
  }
  await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    if (s <= Math.max(num(me.cleared_before_seq), num(me.from_seq)))
      throw new MessengerNotFoundError('Message not found in this chat.');
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
  if (!message) throw new MessengerNotFoundError('Message not found in this chat.');
  return message;
}

/** Delete a message for everyone (soft: body blanked, deleted_at set): the
 *  author, or a group admin for any message of the group. */
export async function deleteMessengerMessage(
  actor: MessengerActor,
  conversationId: string,
  seq: number,
): Promise<void> {
  takeBudget(actor, 'write');
  const s = seqOr(seq, 'seq');
  await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    if (s <= Math.max(num(me.cleared_before_seq), num(me.from_seq)))
      throw new MessengerNotFoundError('Message not found in this chat.');
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
  takeBudget(actor, 'write');
  const s = seqOr(seq, 'seq');
  const e = typeof emoji === 'string' ? emoji.trim() : '';
  if (e === '' || e.length > MESSENGER_EMOJI_MAX || /\s/.test(e)) {
    throw new InputError('A reaction must be one emoji.');
  }
  const self = actor.loginId.toLowerCase();
  return systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    if (s <= Math.max(num(me.cleared_before_seq), num(me.from_seq)))
      throw new MessengerNotFoundError('Message not found in this chat.');
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
 *  seq I may read). Answers the cursor. One update of my own row with
 *  greatest(): it takes no lock on the conversation, so a read never waits
 *  for the sends. */
export async function markMessengerRead(
  actor: MessengerActor,
  conversationId: string,
  seq: number,
): Promise<{ lastReadSeq: number }> {
  takeBudget(actor, 'write');
  const s = seqOr(seq, 'seq');
  const c = uuidOr(conversationId, 'The conversation');
  const P = messengerParticipants;
  const mine = and(
    eq(P.conversationId, c),
    eq(P.kind, 'login'),
    eq(P.loginId, actor.loginId),
    sql`exists (select 1 from messenger_conversations k
                 where k.id = ${P.conversationId} and k.owner_id = ${actor.ownerId}::uuid)`,
  );
  // The furthest I may read: my leave, else the conversation's last seq.
  const cap = sql`least(${s}::bigint, coalesce(${P.leftSeq},
    (select k.last_seq from messenger_conversations k where k.id = ${P.conversationId})))`;
  // One statement: greatest() keeps the cursor from moving back, and an
  // unchanged cursor raises no event (the trigger compares the values).
  const [row] = await systemDb
    .update(P)
    .set({ lastReadSeq: sql`greatest(${P.lastReadSeq}, ${cap})` })
    .where(mine)
    .returning({ lastReadSeq: P.lastReadSeq });
  if (!row) throw new MessengerNotFoundError();
  return { lastReadSeq: num(row.lastReadSeq) };
}

/** Clear for me: I see nothing up to the last seq;
 *  nobody else is affected; my unread resets. */
export async function clearMessengerForMe(
  actor: MessengerActor,
  conversationId: string,
): Promise<{ clearedBeforeSeq: number }> {
  takeBudget(actor, 'write');
  return systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId, { live: false });
    const upTo = Math.max(
      me.left_at ? num(me.left_seq) : num(conv.last_seq),
      num(me.cleared_before_seq),
    );
    await tx
      .update(messengerParticipants)
      .set({
        clearedBeforeSeq: upTo,
        lastReadSeq: Math.max(upTo, num(me.last_read_seq)),
      })
      .where(eq(messengerParticipants.id, me.id));
    return { clearedBeforeSeq: upTo };
  });
}

export type MessengerPatchInput = {
  title?: string | null;
  icon?: string | null;
  color?: string | null;
  info?: string | null;
  muted?: boolean;
};

/** PATCH /api/messenger/c/:id: the title, the icon, the colour and the
 *  info (group admins; a change of any raises the room's participants
 *  event; a title or info change writes a system line too), and my own
 *  mute. The picture, the workspace and the agent are not set here. */
export async function patchMessengerConversation(
  actor: MessengerActor,
  conversationId: string,
  input: MessengerPatchInput,
): Promise<void> {
  takeBudget(actor, 'write');
  const icon = lookIcon(input.icon);
  const color = lookColor(input.color);
  const info = infoText(input.info);
  const look = icon !== undefined || color !== undefined;
  await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId, {
      live: input.title !== undefined || info !== undefined || look,
    });
    if (look) {
      requireGroupAdmin(conv, me);
      await tx
        .update(messengerConversations)
        .set({
          ...(icon !== undefined ? { icon } : {}),
          ...(color !== undefined ? { color } : {}),
        })
        .where(eq(messengerConversations.id, conv.id));
    }
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
        const names = await loginNames([actor.loginId], tx);
        await systemLine(
          tx,
          conv,
          `${names.get(actor.loginId) ?? 'Someone'} renamed the group${title ? ` to "${title}"` : ''}.`,
        );
      }
    }
    if (info !== undefined) {
      // The same rights and the same record as a title change: a group
      // admin, and a system line in the group (the audit row) when the
      // text changes. The text itself stays out of the line.
      requireGroupAdmin(conv, me);
      if (info !== conv.info) {
        await tx
          .update(messengerConversations)
          .set({ info })
          .where(eq(messengerConversations.id, conv.id));
        const names = await loginNames([actor.loginId], tx);
        await systemLine(
          tx,
          conv,
          `${names.get(actor.loginId) ?? 'Someone'} ${info ? 'changed' : 'cleared'} the group's info.`,
        );
      }
    }
    if (input.muted !== undefined && input.muted !== me.muted) {
      await tx
        .update(messengerParticipants)
        .set({ muted: input.muted === true })
        .where(eq(messengerParticipants.id, me.id));
    }
  });
}

/** Delete history for everyone: a group admin removes
 *  every message of the group, or those older than `before`. A system line
 *  records it. A direct chat has no delete-for-everyone in V1.
 *
 *  The deleted part is every seq up to a ceiling (the newest older than
 *  `before`), so what is left is one run of seqs. In the same transaction
 *  every participant's clear moves up to the ceiling (the unread and the
 *  mention count only what is left), and a `history` event tells each
 *  stream to load the chat again: a deleted row raises no message event. */
export async function deleteMessengerHistory(
  actor: MessengerActor,
  conversationId: string,
  before?: Date | null,
): Promise<{ deleted: number }> {
  takeBudget(actor, 'write');
  if (before && Number.isNaN(before.getTime())) throw new InputError('before must be a date.');
  return systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    requireGroupAdmin(conv, me);
    const [top] = await q<{ ceiling: string | number | null }>(
      tx,
      sql`select max(seq) as ceiling from messenger_messages
           where conversation_id = ${conv.id}::uuid
             ${before ? sql`and created_at < ${before.toISOString()}::timestamptz` : sql``}`,
    );
    const ceiling = numOrNull(top?.ceiling);
    let deleted = 0;
    if (ceiling !== null) {
      const gone = await tx
        .delete(messengerMessages)
        .where(
          and(eq(messengerMessages.conversationId, conv.id), lte(messengerMessages.seq, ceiling)),
        )
        .returning({ id: messengerMessages.id });
      deleted = gone.length;
      await tx
        .update(messengerParticipants)
        .set({ clearedBeforeSeq: ceiling })
        .where(
          and(
            eq(messengerParticipants.conversationId, conv.id),
            lt(messengerParticipants.clearedBeforeSeq, ceiling),
          ),
        );
      await tx.execute(
        sql`select pg_notify('messenger_changed', ${JSON.stringify({ c: conv.id, seq: ceiling, kind: 'history', actor: actor.loginId.toLowerCase() })})`,
      );
    }
    const names = await loginNames([actor.loginId], tx);
    await systemLine(
      tx,
      conv,
      `${names.get(actor.loginId) ?? 'Someone'} deleted the history${
        before ? ` before ${before.toISOString().slice(0, 10)}` : ''
      }.`,
    );
    return { deleted };
  });
}

// ── Membership ───────────────────────────────────────────────────────────────

/** Add logins to a group (a group admin). Each must be in the actor's
 *  directory; one who left comes back (and reads the group again). */
export async function addMessengerParticipants(
  actor: MessengerActor,
  conversationId: string,
  loginIds: readonly string[],
): Promise<{ added: string[] }> {
  takeBudget(actor, 'write');
  const self = actor.loginId.toLowerCase();
  const ids = [...new Set(loginIds.map((l) => uuidOr(l, 'A participant')))].filter(
    (l) => l !== self,
  );
  if (ids.length === 0) throw new InputError('Name at least one login to add (pass logins).');
  const reach = await peopleVisibleTo(actor, { only: ids, limit: 500 });
  if (reach.length !== ids.length) {
    throw new MessengerRefusedError('You can only add people who share a workspace with you.');
  }
  return systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    requireGroupAdmin(conv, me);
    if (conv.agent_id) {
      // A group with an agent takes only users of its workspace.
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
    const names = await loginNames([self, ...added], tx);
    // An added login reads from this line on (from_seq), never the history
    // before it or the gap while it was out.
    const line = await systemLine(
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
          fromSeq: line - 1,
          lastReadSeq: line - 1,
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
          fromSeq: line - 1,
          lastReadSeq: line - 1,
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
  takeBudget(actor, 'write');
  const target = uuidOr(loginId, 'The participant');
  if (target === actor.loginId.toLowerCase()) {
    throw new InputError('To go yourself, leave the chat: you must not remove yourself.');
  }
  const room = await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    requireGroupAdmin(conv, me);
    const [p] = await q<{ id: string; left_at: Date | null }>(
      tx,
      sql`select id::text as id, left_at from messenger_participants
           where conversation_id = ${conv.id}::uuid and kind = 'login' and login_id = ${target}::uuid`,
    );
    if (!p || p.left_at) throw new MessengerNotFoundError('Participant not found in this chat.');
    const names = await loginNames([actor.loginId, target], tx);
    const seq = await systemLine(
      tx,
      conv,
      `${names.get(actor.loginId) ?? 'Someone'} removed ${names.get(target) ?? 'someone'}.`,
    );
    await tx
      .update(messengerParticipants)
      .set({ leftAt: sql`now()`, leftSeq: seq, admin: false })
      .where(eq(messengerParticipants.id, p.id));
    return dropFromOpenCall(tx, conv.id, target);
  });
  await dropFromRoom(room, target);
}

/** Leave a group (anyone; a direct chat cannot be left, only cleared). The
 *  last admin who leaves hands admin to the longest-standing member; a
 *  group with no login left is archived. */
export async function leaveMessengerConversation(
  actor: MessengerActor,
  conversationId: string,
): Promise<void> {
  takeBudget(actor, 'write');
  const room = await systemDb.transaction(async (tx) => {
    const { conv, me } = await lockForActor(tx, actor, conversationId);
    if (conv.kind !== 'group') {
      throw new MessengerRefusedError('A direct chat cannot be left; clear it instead.');
    }
    const names = await loginNames([actor.loginId], tx);
    const seq = await systemLine(tx, conv, `${names.get(actor.loginId) ?? 'Someone'} left.`);
    await tx
      .update(messengerParticipants)
      .set({ leftAt: sql`now()`, leftSeq: seq, admin: false })
      .where(eq(messengerParticipants.id, me.id));
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
      await tx
        .update(messengerParticipants)
        .set({ admin: true })
        .where(eq(messengerParticipants.id, rest[0]!.id));
    }
    return dropFromOpenCall(tx, conv.id, actor.loginId);
  });
  await dropFromRoom(room, actor.loginId);
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
  takeBudget(actor, 'write');
  const ref = uuidOr(refId, 'The pin');
  if (kind !== 'conversation' && kind !== 'agent') {
    throw new InputError('kind must be "conversation" or "agent".');
  }
  if (!Number.isSafeInteger(rank) || rank < 0 || rank > 1_000_000) {
    throw new InputError('rank must be a whole number from 0 to 1000000.');
  }
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
    if (!agents.some((a) => a.id === ref))
      throw new MessengerNotFoundError('Agent not found among the agents you may chat with.');
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
  takeBudget(actor, 'write');
  const ref = uuidOr(refId, 'The pin');
  if (kind !== 'conversation' && kind !== 'agent') {
    throw new InputError('kind must be "conversation" or "agent".');
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
  event: MessengerEventJson | null;
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
};

/**
 * My participant rows (of one conversation, or all with `c` null), each
 * with the conversation's tail as I may see it: `last_seq` capped at my
 * leave, and for a leaver no `last_message_at` and no `last_preview`. In a
 * scope the workspace role reads neither the tail nor any cursor column
 * (migration 0336): mantle_messenger_mine answers them, for the scope's own
 * login. Outside a scope (the admin pool) the same rows inline. Both name
 * the login again.
 */
function MINE(actor: MessengerActor, c: string | null): SQL {
  const one = c === null ? sql`null::uuid` : sql`${c}::uuid`;
  if (currentWorkspaceScope()) {
    return sql`(select * from mantle_messenger_mine(${one}) x
                 where x.login_id = ${actor.loginId}::uuid)`;
  }
  return sql`(select p.conversation_id, p.login_id, p.admin, p.joined_at, p.left_at, p.left_seq,
                     p.last_read_seq, p.mention_seq, p.cleared_before_seq, p.from_seq, p.muted,
                     case when p.left_at is null then k.last_seq
                          else least(k.last_seq, p.left_seq) end as last_seq,
                     case when p.left_at is null then k.last_message_at end as last_message_at,
                     case when p.left_at is null then k.last_preview end as last_preview
                from messenger_participants p
                join messenger_conversations k on k.id = p.conversation_id
               where p.kind = 'login' and p.login_id = ${actor.loginId}::uuid
                 and (${one} is null or p.conversation_id = ${one}))`;
}

/** The window of seqs a login may see in a conversation: after its clear
 *  and its add line, up to its leave. */
const MY_WINDOW = (actor: MessengerActor, c: string) => sql`
  join ${MINE(actor, c)} me
    on me.conversation_id = m.conversation_id
   and m.seq > me.cleared_before_seq
   and m.seq > me.from_seq
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
    event: r.event ?? null,
    editedAt: isoOrNull(r.edited_at),
    deletedAt: isoOrNull(r.deleted_at),
    createdAt: iso(r.created_at),
    reactions: byMessage.get(r.id) ?? [],
  }));
}

const MESSAGE_COLUMNS = sql`m.id::text as id, m.conversation_id::text as conversation_id, m.seq,
  m.author_kind, m.author_login_id::text as author_login_id, m.author_agent_id::text as author_agent_id,
  m.author_name, m.via, m.body, m.attachments, m.mentions, m.reply_to_seq, m.client_msg_id, m.status,
  m.event, m.edited_at, m.deleted_at, m.created_at`;

async function readMessagesBySeq(
  actor: MessengerActor,
  conversationId: string,
  seqs: readonly number[],
): Promise<MessengerMessageView[]> {
  const rows = await q<MessageRow>(
    db,
    sql`select ${MESSAGE_COLUMNS} from messenger_messages m ${MY_WINDOW(actor, conversationId)}
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
 * GET /api/messenger/c/:id/messages: oldest first in the window, `limit`
 * (default 20, at most 100) at a time.
 *  - neither cursor: the last `limit`;
 *  - before_seq: the `limit` below it (scrolling up); `hasMore`: there are
 *    older ones;
 *  - after_seq: the `limit` after it (the catch-up). `hasMore`: there are
 *    newer ones, and `lastSeq` is then the highest seq of this page, so the
 *    next after_seq misses nothing; without more, `lastSeq` is the last seq
 *    I may read.
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
    sql`select me.last_seq
          from messenger_conversations c
          join ${MINE(actor, c)} me on me.conversation_id = c.id
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
      sql`select ${MESSAGE_COLUMNS} from messenger_messages m ${MY_WINDOW(actor, c)}
           where m.conversation_id = ${c}::uuid and m.seq > ${after} ${skip}
           order by m.seq asc limit ${limit + 1}`,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      messages: await decorate(actor, page),
      // A send between the two reads can land in the page: never below it.
      lastSeq: hasMore
        ? num(page[page.length - 1]!.seq)
        : Math.max(num(conv.last_seq), page.length ? num(page[page.length - 1]!.seq) : 0),
      hasMore,
    };
  }
  const before = input.beforeSeq != null ? seqOr(input.beforeSeq, 'before_seq') : null;
  rows = await q<MessageRow>(
    db,
    sql`select ${MESSAGE_COLUMNS} from messenger_messages m ${MY_WINDOW(actor, c)}
         where m.conversation_id = ${c}::uuid ${before !== null ? sql`and m.seq < ${before}` : sql``}
         order by m.seq desc limit ${limit + 1}`,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  const top = page.length ? num(page[page.length - 1]!.seq) : 0;
  return {
    messages: await decorate(actor, page),
    lastSeq: Math.max(num(conv.last_seq), top),
    hasMore,
  };
}

type ParticipantReadRow = {
  conversation_id: string;
  kind: 'login' | 'agent';
  id: string;
  admin: boolean;
  left_at: Date | null;
};

/**
 * The people of each conversation as `actor` may see them: never one who
 * left before the actor joined; for a conversation it left, only those
 * added before it left, and a later leave shown as not yet (the title and
 * admin flags are the room's current ones). Judged by seqs. In a scope
 * mantle_messenger_people answers it (the workspace role reads no left_at,
 * 0336); outside one the same rows inline (people.ts roomPeopleSql).
 */
function PEOPLE(actor: MessengerActor, conversationIds: readonly string[]): SQL {
  const cs = uuidArray(conversationIds);
  if (currentWorkspaceScope()) return sql`mantle_messenger_people(${cs})`;
  return roomPeopleSql(actor.loginId, cs);
}

/** The people of each conversation as `actor` may see them (PEOPLE). */
async function participantsOf(
  actor: MessengerActor,
  conversationIds: readonly string[],
): Promise<Map<string, MessengerParticipantView[]>> {
  const out = new Map<string, MessengerParticipantView[]>();
  if (conversationIds.length === 0) return out;
  const rows = await q<ParticipantReadRow>(
    db,
    sql`select x.conversation_id::text as conversation_id, x.kind, x.id::text as id, x.admin,
               x.left_at
          from ${PEOPLE(actor, conversationIds)} x
         order by x.joined_at, x.id`,
  );
  const [ln, an] = await Promise.all([
    loginFaces(actor, [...new Set(rows.filter((r) => r.kind === 'login').map((r) => r.id))]),
    agentFaces(actor.ownerId, [
      ...new Set(rows.filter((r) => r.kind === 'agent').map((r) => r.id)),
    ]),
  ]);
  for (const r of rows) {
    const list = out.get(r.conversation_id) ?? [];
    const base = { kind: r.kind, id: r.id, admin: r.admin, leftAt: isoOrNull(r.left_at) };
    if (r.kind === 'login') {
      const f = ln.get(r.id);
      list.push({
        ...base,
        name: f?.name ?? 'Someone',
        avatar: f?.avatar ?? null,
        photoVersion: f?.photoVersion ?? null,
      });
    } else {
      const f = an.get(r.id);
      list.push({ ...base, name: f?.name ?? 'Someone', avatar: f?.avatar ?? null });
    }
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
    icon: string | null;
    color: string | null;
    info: string | null;
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
    sql`select c.id::text as id, c.kind, c.title, c.icon, c.color, c.info,
               c.created_by::text as created_by, c.created_at,
               c.archived_at, me.last_seq, me.last_message_at,
               c.workspace_id::text as workspace_id,
               c.agent_id::text as agent_id, me.admin, me.last_read_seq, me.cleared_before_seq, me.muted,
               me.left_seq
          from messenger_conversations c
          join ${MINE(actor, c)} me on me.conversation_id = c.id
         where c.id = ${c}::uuid and c.owner_id = ${actor.ownerId}::uuid`,
  );
  if (!row) throw new MessengerNotFoundError();
  const parts = (await participantsOf(actor, [row.id])).get(row.id) ?? [];
  return {
    id: row.id,
    kind: row.kind,
    title: row.kind === 'direct' ? null : row.title,
    icon: row.kind === 'direct' ? null : row.icon,
    color: row.kind === 'direct' ? null : row.color,
    info: row.kind === 'direct' ? null : row.info,
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
  icon: string | null;
  color: string | null;
  last_seq: string | number;
  last_message_at: Date | null;
  last_preview: MessengerPreviewView | null;
  muted: boolean;
  unread: string | number;
  mention: boolean;
  favourite: boolean;
  fav_rank: number | null;
};

/** My people chats and groups with their unread arithmetic: last seq I may read minus the greater of my read cursor and my clear,
 *  never below zero. */
async function myConversationRows(actor: MessengerActor, unreadOnly = false): Promise<ListRow[]> {
  return q<ListRow>(
    db,
    sql`select c.id::text as id, c.kind, c.title, c.icon, c.color, me.last_seq, me.last_message_at,
               me.last_preview, me.muted,
               greatest(0, me.last_seq - greatest(me.last_read_seq, me.cleared_before_seq)) as unread,
               me.mention_seq > greatest(me.last_read_seq, me.cleared_before_seq) as mention,
               f.login_id is not null as favourite, f.rank as fav_rank
          from ${MINE(actor, null)} me
          join messenger_conversations c on c.id = me.conversation_id
          left join messenger_favourites f
            on f.login_id = me.login_id and f.kind = 'conversation' and f.ref_id = c.id
         where c.owner_id = ${actor.ownerId}::uuid
           ${unreadOnly ? sql`and me.last_seq > greatest(me.last_read_seq, me.cleared_before_seq)` : sql``}`,
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

/** My agent threads (assistant_messages): each agent I may
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
  const parts = await participantsOf(
    actor,
    convs.map((c) => c.id),
  );
  const rows: (MessengerListRowView & { rank: number | null })[] = [
    ...convs.map((c) => {
      const ps = parts.get(c.id) ?? [];
      return {
        kind: c.kind,
        id: c.id,
        title: titleFor(c.kind, c.title, ps, actor.loginId),
        icon: c.kind === 'direct' ? null : c.icon,
        color: c.kind === 'direct' ? null : c.color,
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
 *  rows count too: muted chats count but never pop) plus
 *  the agent threads' replies after my cursor. */
export async function messengerUnread(
  actor: MessengerActor,
): Promise<{ total: number; messenger: number; agents: number }> {
  const [row] = await q<{ n: string | number | null }>(
    db,
    sql`select sum(greatest(0, me.last_seq - greatest(me.last_read_seq, me.cleared_before_seq))) as n
          from ${MINE(actor, null)} me
          join messenger_conversations c on c.id = me.conversation_id
         where c.owner_id = ${actor.ownerId}::uuid`,
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
): Promise<{ loginId: string; leftSeq: number | null; fromSeq: number }[]> {
  if (!isUuid(conversationId)) return [];
  const rows = await q<{
    login_id: string;
    left_seq: string | number | null;
    from_seq: string | number;
  }>(
    systemDb,
    sql`select login_id::text as login_id, left_seq, from_seq from messenger_participants
         where conversation_id = ${conversationId}::uuid and kind = 'login'`,
  );
  return rows.map((r) => ({
    loginId: r.login_id,
    leftSeq: numOrNull(r.left_seq),
    fromSeq: num(r.from_seq),
  }));
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

/** Raise a typing event: a NOTIFY, stored nowhere. Only a
 *  live participant's. */
export async function messengerTyping(
  actor: MessengerActor,
  conversationId: string,
): Promise<void> {
  const c = uuidOr(conversationId, 'The conversation');
  const [p] = await q<{ ok: number }>(
    db,
    sql`select 1 as ok from ${MINE(actor, c)} me where me.left_at is null`,
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

// ── The via label ────────────────────────────────────────────────────────────

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

// ── Wait (messenger_wait) ────────────────────────────────────────────────────

/** messenger_wait's longest wait. */
export const MESSENGER_WAIT_MAX_MS = 60_000;

type Listener = (payload: { c: string; seq: number | null; kind: string }) => void;
const waitListeners = new Set<Listener>();
let listening: Promise<void> | null = null;
/** One open wait per credential: a new wait from the
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
 * most), at most 100 at a time: `hasMore` says there are more, and
 * `lastSeq` is then the highest seq answered (the next after_seq). Messages
 * sent through the caller's own credential (via_ref; a
 * session's own null) are skipped: two clients on one login wait for each
 * other (decision 19.3). Every check runs here, in the caller's own scope:
 * the LISTEN callback only wakes it.
 */
export async function waitForMessengerMessages(
  actor: MessengerActor,
  conversationId: string,
  afterSeq: number,
  timeoutMs: number,
): Promise<{
  messages: MessengerMessageView[];
  lastSeq: number;
  hasMore: boolean;
  timedOut: boolean;
}> {
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
      hasMore: first.hasMore,
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
      if (got.messages.length > 0)
        return { messages: got.messages, lastSeq, hasMore: got.hasMore, timedOut: false };
    }
    return { messages: [], lastSeq, hasMore: false, timedOut: true };
  } finally {
    waitListeners.delete(onEvent);
    if (openWaits.get(key) === cancel) openWaits.delete(key);
  }
}
