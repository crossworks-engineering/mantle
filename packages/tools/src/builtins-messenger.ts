/**
 * The messenger on the one MCP surface every login has (Messenger V1, plan
 * page d8954876, sections 6 and 12): list, open, send, create, wait, mark
 * read, directory. Each runs as the caller (its login and its scope); a
 * message records the credential it came through (via), and
 * messenger_wait skips the caller's own, so two clients on one login wait
 * for each other.
 *
 * MCP only: an agent tool group `messenger` is Phase 6 (a send by an agent
 * is an outward act). None spends on the owner's keys, none is risky, and
 * nothing here starts a turn: a mention is stored, no more.
 */
import {
  createMessengerConversation,
  getMessengerConversation,
  listMessengerConversations,
  listMessengerMessages,
  markMessengerRead,
  messengerDirectory,
  messengerViaFor,
  sendMessengerMessage,
  waitForMessengerMessages,
  MESSENGER_WAIT_MAX_MS,
  MessengerNotFoundError,
  MessengerRefusedError,
  type MessengerActor,
} from '@mantle/content/messenger';
import { itemErrorText } from '@mantle/std';
import type { BuiltinToolDef, ToolHandlerContext } from './types';
import { ownerSurfaceLoginId } from './surface';
import { CS } from './client-sourced-rule';

/** The caller as the messenger sees it: the connection's login, and the
 *  credential of its MCP connection as via. A connection that names no
 *  login is the brain owner only on the local stdio server (no MCP
 *  channel); any other one (a peer bound to an Admin user the owner did not
 *  register) is refused, never the owner. */
async function actorOf(ctx: ToolHandlerContext): Promise<MessengerActor> {
  const mcp = ctx.surface?.kind === 'owner' ? ctx.surface.mcp : undefined;
  const named = ownerSurfaceLoginId(ctx.surface);
  const stdio = ctx.surface?.kind === 'owner' && ctx.surface.via === 'mcp' && !mcp;
  if (!named && !stdio) {
    throw new MessengerRefusedError(
      'The messenger needs a connection that acts as one login: connect with your own login (OAuth or an API key).',
    );
  }
  const loginId = named ?? ctx.ownerId;
  const via = mcp
    ? await messengerViaFor({
        oauthClientId: mcp.oauthClientId ?? null,
        keyId: mcp.keyId ?? null,
        peerId: mcp.peerId ?? null,
      })
    : null;
  return { ownerId: ctx.ownerId, loginId, via };
}

/** A refusal the caller should read (not found, not allowed, a bad value)
 *  as its own text; anything else the safe message. */
function fail(err: unknown): { ok: false; error: string } {
  const text = itemErrorText(err, 'messenger', 'The messenger could not do that; try again.');
  const hint =
    err instanceof MessengerNotFoundError ? ' Find your chats with `messenger_list`.' : '';
  return { ok: false, error: `${text}${hint}` };
}

function int(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
}

const CONVERSATION = {
  type: 'string',
  description: 'The conversation id (from messenger_list or messenger_create).',
} as const;

export const messenger_list: BuiltinToolDef = {
  slug: 'messenger_list',
  policy: { effect: 'read', spends: 'none', scope: 'any' },
  mcpOnly: true,
  name: 'List my chats',
  description:
    'Your messenger chats: direct chats, groups and your assistant threads, favourites first, then the newest. Each row has its id, title, unread count, whether a message mentions you, and the last line. Pass unread_only to list only the chats with something new. Read a people chat or group with `messenger_open`; an assistant thread is read in the chat with that assistant, not here.',
  inputSchema: {
    type: 'object',
    properties: {
      unread_only: { type: 'boolean', description: 'Only the chats with unread messages.' },
    },
  },
  handler: async (input, ctx) => {
    try {
      const rows = await listMessengerConversations(await actorOf(ctx), {
        unreadOnly: input.unread_only === true,
      });
      return {
        ok: true,
        output: {
          chats: rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            title: r.title,
            unread: r.unread,
            mention: r.mention,
            lastSeq: r.lastSeq,
            lastMessageAt: r.lastMessageAt,
            last: r.preview
              ? `${r.preview.authorName ?? ''}${r.preview.authorName ? ': ' : ''}${r.preview.text}`
              : null,
            ...(r.agentSlug ? { agentSlug: r.agentSlug } : {}),
          })),
        },
      };
    } catch (err) {
      return fail(err);
    }
  },
};

export const messenger_open: BuiltinToolDef = {
  slug: 'messenger_open',
  policy: { effect: 'read', spends: 'none', scope: 'any' },
  mcpOnly: true,
  name: 'Read a chat',
  description:
    "Messages of one chat, oldest first, with who is in it. With no cursor: the last messages. before_seq: the ones below it (older). after_seq: the ones after it (what is new since you last looked); when hasMore is true, pass the answer's lastSeq as the next after_seq for the rest. Each message has its seq; pass the highest one to `messenger_wait` or `messenger_mark_read`. To find a chat use `messenger_list`.",
  inputSchema: {
    type: 'object',
    properties: {
      conversation: CONVERSATION,
      before_seq: { type: 'integer', minimum: 0, description: 'Older than this seq.' },
      after_seq: { type: 'integer', minimum: 0, description: 'Newer than this seq.' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 20,
        description: 'How many messages.',
      },
    },
    required: ['conversation'],
  },
  handler: async (input, ctx) => {
    try {
      const actor = await actorOf(ctx);
      const conversation = String(input.conversation ?? '');
      const beforeSeq = int(input.before_seq);
      const afterSeq = int(input.after_seq);
      const limit = int(input.limit);
      if ([beforeSeq, afterSeq, limit].some((n) => Number.isNaN(n))) {
        return { ok: false, error: 'before_seq, after_seq and limit are whole numbers.' };
      }
      const [conv, page] = await Promise.all([
        getMessengerConversation(actor, conversation),
        listMessengerMessages(actor, conversation, { beforeSeq, afterSeq, limit }),
      ]);
      return {
        ok: true,
        output: {
          conversation: {
            id: conv.id,
            kind: conv.kind,
            title: conv.title,
            // A group's info: what it is for and its rules, as its admins
            // wrote it (plain text, under the same taint as any member's
            // line); null on a direct chat and a group without one.
            info: conv.info,
            participants: conv.participants.map(faceless),
            lastReadSeq: conv.me.lastReadSeq,
          },
          messages: page.messages.map(slim),
          lastSeq: page.lastSeq,
          hasMore: page.hasMore,
        },
      };
    } catch (err) {
      return fail(err);
    }
  },
};

/** A person or an entry as a tool answers it: no avatar and no photo
 *  version. They draw a face in the chat window and tell a model nothing,
 *  so they stay out of its context. */
function faceless<T extends { avatar?: unknown; photoVersion?: unknown }>(
  p: T,
): Omit<T, 'avatar' | 'photoVersion'> {
  const { avatar: _avatar, photoVersion: _photoVersion, ...rest } = p;
  return rest;
}

/** A message as a tool answers it: what a reader needs, nothing more. */
function slim(m: Awaited<ReturnType<typeof listMessengerMessages>>['messages'][number]) {
  return {
    seq: m.seq,
    author: m.authorName,
    authorId: m.authorId,
    authorKind: m.authorKind,
    ...(m.via ? { via: m.via } : {}),
    text: m.deletedAt ? '(deleted)' : m.body,
    ...(m.replyToSeq ? { replyToSeq: m.replyToSeq } : {}),
    ...(m.editedAt ? { edited: true } : {}),
    at: m.createdAt,
  };
}

export const messenger_send: BuiltinToolDef = {
  slug: 'messenger_send',
  policy: {
    effect: 'write',
    matrix: { none: 'a messenger message, not an item' },
    spends: 'none',
    scope: 'any',
    clientSourced: CS.free('a message the caller writes as itself in a chat it is in'),
  },
  mcpOnly: true,
  name: 'Send a chat message',
  description:
    'Send a message as yourself in a chat you are in. It is marked with how you are connected. Give client_msg_id (any unique text) to make a retry safe: the same id twice sends once. Answers the stored message with its seq. Visible at once to everyone in the chat; to wait for an answer use `messenger_wait`.',
  inputSchema: {
    type: 'object',
    properties: {
      conversation: CONVERSATION,
      text: {
        type: 'string',
        maxLength: 8000,
        description: 'The message, in markdown, e.g. "The report is done."',
      },
      reply_to_seq: {
        type: 'integer',
        minimum: 1,
        description: 'The seq of the message this answers.',
      },
      client_msg_id: {
        type: 'string',
        maxLength: 100,
        description: 'A unique id for safe retries.',
      },
    },
    required: ['conversation', 'text'],
  },
  handler: async (input, ctx) => {
    try {
      const replyTo = int(input.reply_to_seq);
      if (Number.isNaN(replyTo)) return { ok: false, error: 'reply_to_seq is a whole number.' };
      const out = await sendMessengerMessage(await actorOf(ctx), String(input.conversation ?? ''), {
        body: typeof input.text === 'string' ? input.text : '',
        replyToSeq: replyTo,
        clientMsgId: typeof input.client_msg_id === 'string' ? input.client_msg_id : null,
      });
      return { ok: true, output: { sent: out.created, message: slim(out.message) } };
    } catch (err) {
      return fail(err);
    }
  },
};

export const messenger_create: BuiltinToolDef = {
  slug: 'messenger_create',
  policy: {
    effect: 'write',
    matrix: { none: 'a messenger conversation, not an item' },
    spends: 'none',
    scope: 'any',
    clientSourced: CS.free('a chat the caller starts with people in its directory'),
  },
  mcpOnly: true,
  name: 'Start a chat',
  description:
    'Start a direct chat (kind "direct", exactly one other person: an existing chat with them is answered instead) or a group (kind "group", any number of people, none for a chat with yourself, with an optional title and info: what it is for and its rules, which `messenger_open` shows to everyone in it). Only people `messenger_directory` lists. Answers the conversation id for `messenger_send`.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['direct', 'group'],
        description: 'A direct chat with one person, or a group.',
      },
      participants: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 200,
        description: 'Login ids from messenger_directory, besides you.',
      },
      title: { type: 'string', maxLength: 200, description: "A group's title." },
      info: {
        type: 'string',
        maxLength: 2000,
        description:
          'A group\'s info, plain text: what it is for and its rules, e.g. "Post requests here. Say what you tried and what you expected." Groups only: a direct chat refuses it.',
      },
    },
    required: ['kind', 'participants'],
  },
  handler: async (input, ctx) => {
    try {
      const kind = input.kind === 'direct' || input.kind === 'group' ? input.kind : null;
      if (!kind) return { ok: false, error: 'kind is "direct" or "group".' };
      const participants = Array.isArray(input.participants) ? input.participants.map(String) : [];
      if (input.info !== undefined && input.info !== null && typeof input.info !== 'string') {
        return { ok: false, error: 'info is text (what the group is for and its rules).' };
      }
      const out = await createMessengerConversation(await actorOf(ctx), {
        kind,
        participants,
        title: typeof input.title === 'string' ? input.title : null,
        ...(typeof input.info === 'string' ? { info: input.info } : {}),
      });
      return { ok: true, output: { conversation: out.conversationId, created: out.created } };
    } catch (err) {
      return fail(err);
    }
  },
};

export const messenger_wait: BuiltinToolDef = {
  slug: 'messenger_wait',
  policy: { effect: 'read', spends: 'none', scope: 'any' },
  mcpOnly: true,
  name: 'Wait for chat messages',
  description:
    "Wait for new messages in a chat after after_seq, instead of polling. Answers at once if there are some, else the moment one lands, else empty at the timeout. Messages you sent through this same connection are left out, so two clients on one login wait for each other. Pass the answer's lastSeq as the next after_seq: when hasMore is true, call again at once for the rest. To read older messages use `messenger_open`.",
  inputSchema: {
    type: 'object',
    properties: {
      conversation: CONVERSATION,
      after_seq: { type: 'integer', minimum: 0, description: 'Wait for messages after this seq.' },
      timeout_s: {
        type: 'integer',
        minimum: 0,
        maximum: 60,
        default: 60,
        description: 'Seconds to wait.',
      },
    },
    required: ['conversation', 'after_seq'],
  },
  handler: async (input, ctx) => {
    try {
      const after = int(input.after_seq);
      if (after === null || Number.isNaN(after))
        return { ok: false, error: 'after_seq is a whole number.' };
      const t = int(input.timeout_s);
      if (Number.isNaN(t)) return { ok: false, error: 'timeout_s is a whole number.' };
      const ms = Math.min((t ?? 60) * 1000, MESSENGER_WAIT_MAX_MS);
      const out = await waitForMessengerMessages(
        await actorOf(ctx),
        String(input.conversation ?? ''),
        after,
        ms,
      );
      return {
        ok: true,
        output: {
          messages: out.messages.map(slim),
          lastSeq: out.lastSeq,
          hasMore: out.hasMore,
          timedOut: out.timedOut,
        },
      };
    } catch (err) {
      return fail(err);
    }
  },
};

export const messenger_mark_read: BuiltinToolDef = {
  slug: 'messenger_mark_read',
  policy: {
    idempotent: true, // the cursor only moves forward
    effect: 'write',
    matrix: { none: "the caller's own read cursor, not an item" },
    spends: 'none',
    scope: 'any',
    clientSourced: CS.free("the caller's own read cursor"),
  },
  mcpOnly: true,
  name: 'Mark a chat read',
  description:
    'Mark a chat read up to a seq; your cursor only moves forward, and nobody else is affected. Answers your cursor. To see what is unread use `messenger_list`.',
  inputSchema: {
    type: 'object',
    properties: {
      conversation: CONVERSATION,
      seq: { type: 'integer', minimum: 0, description: 'Read up to here.' },
    },
    required: ['conversation', 'seq'],
  },
  handler: async (input, ctx) => {
    try {
      const seq = int(input.seq);
      if (seq === null || Number.isNaN(seq)) return { ok: false, error: 'seq is a whole number.' };
      const out = await markMessengerRead(
        await actorOf(ctx),
        String(input.conversation ?? ''),
        seq,
      );
      return { ok: true, output: out };
    } catch (err) {
      return fail(err);
    }
  },
};

export const messenger_directory: BuiltinToolDef = {
  slug: 'messenger_directory',
  policy: { effect: 'read', spends: 'none', scope: 'any' },
  mcpOnly: true,
  name: 'Who I may chat with',
  description:
    'The people you may start a chat with (those who share a workspace with you; an Admin user: everyone), each with "online", and the assistants you may chat with. Start a chat with one through `messenger_create`.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', maxLength: 100, description: 'Part of a name, e.g. "chris".' },
    },
  },
  handler: async (input, ctx) => {
    try {
      const entries = await messengerDirectory(
        await actorOf(ctx),
        typeof input.q === 'string' ? input.q : '',
      );
      return { ok: true, output: { entries: entries.map(faceless) } };
    } catch (err) {
      return fail(err);
    }
  },
};

export const MESSENGER_TOOLS: readonly BuiltinToolDef[] = [
  messenger_list,
  messenger_open,
  messenger_send,
  messenger_create,
  messenger_wait,
  messenger_mark_read,
  messenger_directory,
];

export const MESSENGER_TOOL_SLUGS = MESSENGER_TOOLS.map((t) => t.slug);
