/**
 * The messenger (Messenger V1, plan page d8954876, sections 11 and 12):
 * direct chats and groups between the logins of one brain, under
 * /api/messenger/*. The chat with an assistant stays in assistant_messages;
 * the list shows each such thread as a row of kind 'agent' beside the
 * people chats.
 *
 * Every number that orders a chat is a seq: the conversation's last_seq,
 * a message's seq, a participant's read cursor. Clocks never order.
 */

/** A conversation: two logins, or a group. */
export type MessengerConversationKind = 'direct' | 'group';

/** A row of the one list: a people chat, a group, or an agent thread. */
export type MessengerRowKind = MessengerConversationKind | 'agent';

export type MessengerAuthorKind = 'login' | 'agent' | 'system';

export type MessengerParticipantKind = 'login' | 'agent';

/** An agent reply's state (Phase 3); a person's message is always
 *  'complete'. */
export type MessengerMessageStatus = 'complete' | 'pending' | 'failed';

/** The last line of a conversation, kept in its row by the send. */
export type MessengerPreview = {
  authorName: string | null;
  /** The first 140 characters of the body ('' for a deleted message). */
  text: string;
  authorKind: MessengerAuthorKind;
};

/** The avatar a login chose in Appearance, or an agent's: its seed and
 *  builder parts, drawn in the brain's one style. The shape GET /api/shell
 *  gives as `avatar` for the caller's own. */
export type MessengerAvatar = { style: string; seed: string; parts: unknown };

export type MessengerParticipant = {
  kind: MessengerParticipantKind;
  /** The login id or the agent id. */
  id: string;
  name: string;
  /** A group admin. */
  admin: boolean;
  /** ISO, or null while the participant is in the chat. */
  leftAt: string | null;
  /** A login's from its own Appearance seed; an agent's from its avatar
   *  (its slug when it has no seed). null: initials. */
  avatar?: MessengerAvatar | null;
  /** Logins only: the uploaded photo's version, the `v` of
   *  GET /api/messenger/photo/:loginId?v= (what the shell's
   *  `avatarPhotoVersion` is for the caller). null: no photo. The photo
   *  outranks the avatar. */
  photoVersion?: string | null;
};

/** One row of GET /api/messenger/conversations. */
export type MessengerListRow = {
  kind: MessengerRowKind;
  /** The conversation id, or the agent id for an agent thread. */
  id: string;
  title: string;
  /** null for an agent thread (its order is by time). */
  lastSeq: number | null;
  /** ISO, null when nothing was said yet. */
  lastMessageAt: string | null;
  preview: MessengerPreview | null;
  unread: number;
  /** A message mentions me past my read cursor. */
  mention: boolean;
  muted: boolean;
  favourite: boolean;
  /** People and the group's agent; empty for an agent thread. */
  participants: MessengerParticipant[];
  /** An agent thread's agent slug (it opens today's chat screen). */
  agentSlug?: string;
};

export type MessengerListResponse = { rows: MessengerListRow[] };

/** GET /api/messenger/c/:id. */
export type MessengerConversation = {
  id: string;
  kind: MessengerConversationKind;
  title: string | null;
  createdBy: string | null;
  createdAt: string;
  archivedAt: string | null;
  lastSeq: number;
  lastMessageAt: string | null;
  /** The bound workspace (Phase 3), or null. */
  workspaceId: string | null;
  /** The group's agent (Phase 3), or null. */
  agentId: string | null;
  participants: MessengerParticipant[];
  /** My own participant row. */
  me: {
    admin: boolean;
    lastReadSeq: number;
    clearedBeforeSeq: number;
    muted: boolean;
    /** Set once I left: I read up to here and nothing after. */
    leftSeq: number | null;
  };
};

export type MessengerMention = { kind: MessengerParticipantKind; id: string };

export type MessengerReaction = { emoji: string; count: number; mine: boolean };

export type MessengerMessage = {
  id: string;
  conversationId: string;
  seq: number;
  authorKind: MessengerAuthorKind;
  /** The login or agent id; null for a system line. */
  authorId: string | null;
  /** The author's name when the message was sent. */
  authorName: string | null;
  /** How it was sent: an OAuth client name, a key label, a peer name. */
  via: string | null;
  /** '' once deleted. */
  body: string;
  /** Attachment ids (Phase 4). */
  attachments: string[];
  mentions: MessengerMention[];
  replyToSeq: number | null;
  clientMsgId: string | null;
  status: MessengerMessageStatus;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  reactions: MessengerReaction[];
};

/** GET /api/messenger/c/:id/messages: oldest first in the window, `limit`
 *  (default 20, at most 100) at a time. */
export type MessengerMessagesResponse = {
  messages: MessengerMessage[];
  /** The last seq I may read; with after_seq and `hasMore`, the highest seq
   *  of this page instead (the next after_seq). */
  lastSeq: number;
  /** More messages exist past this page: below the lowest seq returned
   *  (no cursor, or before_seq), or above the highest (after_seq). */
  hasMore: boolean;
};

/** POST /api/messenger/conversations. */
export type MessengerCreateRequest = {
  kind: MessengerConversationKind;
  /** Login ids besides me. A direct chat names exactly one; a group may
   *  name none (a group of one, "message yourself"). */
  participants: string[];
  title?: string;
};

export type MessengerCreateResponse = {
  conversation: MessengerConversation;
  /** false when a direct chat with that login already existed. */
  created: boolean;
};

/** POST /api/messenger/c/:id/messages. */
export type MessengerSendRequest = {
  body: string;
  mentions?: MessengerMention[];
  replyToSeq?: number | null;
  clientMsgId?: string | null;
  attachments?: string[];
};

export type MessengerSendResponse = {
  message: MessengerMessage;
  /** false when this clientMsgId was already stored (the same row). */
  created: boolean;
};

/** One entry of GET /api/messenger/directory. */
export type MessengerDirectoryEntry = {
  kind: MessengerParticipantKind;
  id: string;
  name: string;
  /** Active in the last two minutes (logins only). */
  online: boolean;
  /** An agent's slug (agents only). */
  slug?: string;
  /** As on a participant. */
  avatar?: MessengerAvatar | null;
  /** Logins only, as on a participant. */
  photoVersion?: string | null;
};

export type MessengerDirectoryResponse = { entries: MessengerDirectoryEntry[] };

/** GET /api/messenger/unread: the badge. */
export type MessengerUnreadResponse = {
  total: number;
  /** People chats and groups. */
  messenger: number;
  /** Agent threads (assistant replies after my read cursor). */
  agents: number;
};

export type MessengerFavouriteKind = 'conversation' | 'agent';

/** The events of GET /api/messenger/stream (ids and seq, never text). */
export type MessengerStreamEvent =
  | { type: 'message'; c: string; seq: number; kind: 'new' | 'edit' | 'delete' }
  | { type: 'read'; c: string; seq: number; loginId: string }
  | { type: 'participants'; c: string }
  | { type: 'reaction'; c: string; seq: number }
  | { type: 'typing'; c: string; loginId: string }
  /** A group's history was deleted: load the chat again, a deleted message
   *  raises no message event. No seq: a leaver must not learn how far the
   *  chat went after it left. */
  | { type: 'history'; c: string };
