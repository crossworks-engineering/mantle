/**
 * Routes every login reaches, whatever its role: about the login itself
 * or its workspaces, never brain data. Each entry is `METHOD pattern`, the pattern exactly as
 * the route manifest writes it. The role sweeps (member-sweep.test.ts,
 * role-sweep.test.ts) let a member and a client through these and refuse
 * them everywhere else outside their own lists. Keep it short.
 */
export const ANY_LOGIN_ROUTES: readonly string[] = [
  // The one (app) shell's chrome (W5c, plan 7.1): every login reads the same
  // shape, `role` says which. Admin-only parts answer empty for the others.
  'GET /api/shell',
  // Public API v1: who the credential (or API key) acts as.
  'GET /api/v1/whoami',
  // Inbound API keys: each login makes, lists and revokes its own keys
  // (an admin also sees and revokes every key). Proved per role in
  // lib/access-keys.db.test.ts.
  'GET /api/access-keys',
  'POST /api/access-keys',
  'DELETE /api/access-keys/:id',
  // Workspaces (W5a): every login lists, makes and leaves its workspaces;
  // a Moderator manages one's users. The rules are in lib/workspaces.ts and
  // in each query: a workspace the login may not see answers 404. Proved per
  // role in lib/workspaces.db.test.ts.
  'GET /api/workspaces',
  'POST /api/workspaces',
  'GET /api/workspaces/user-search',
  'GET /api/workspaces/:id',
  'PATCH /api/workspaces/:id',
  'GET /api/workspaces/:id/archive-preview',
  'POST /api/workspaces/:id/archive',
  'POST /api/workspaces/:id/users',
  'PATCH /api/workspaces/:id/users/:loginId',
  'DELETE /api/workspaces/:id/users/:loginId',
  'POST /api/workspaces/:id/resources',
  'PATCH /api/workspaces/:id/resources/:kind/:refId',
  'DELETE /api/workspaces/:id/resources/:kind/:refId',
  // Grants (W5b2): the Grant Access panel. The rules are in lib/grants.ts
  // and in each query: an item or workspace the login may not see answers
  // 404. Proved per role in lib/grants.db.test.ts.
  'GET /api/grants/:nodeId',
  'POST /api/grants/:nodeId',
  'PATCH /api/grants/:nodeId/:wsId',
  'DELETE /api/grants/:nodeId/:wsId',
  'POST /api/grants/:nodeId/:wsId/restore',
  'POST /api/grants/:nodeId/:wsId/hand',
  'POST /api/grants/:nodeId/embeds',
  'GET /api/grants/:nodeId/preview',
  'POST /api/grants/move',
  'POST /api/grants/move/preview',
];

/**
 * The chat routes (workspaces W7c): every login chats with the assistants of
 * its workspaces, each in its own thread, and reads only its own threads.
 * They hold their own gate (getChatLoginOr401, lib/assistant-chat.ts): an
 * Admin user's request runs as on the owner routes, a member's in its own
 * scope, every read naming the login; a client has no chat (no agent, 404).
 * Proved per role in server/web/server/w7c-chat.db.test.ts.
 */
export const CHAT_LOGIN_ROUTES: readonly string[] = [
  'GET /api/assistant/thread',
  'GET /api/assistant/messages',
  'POST /api/assistant/turn',
  'GET /api/assistant/stream',
  'GET /api/assistant/threads',
  'POST /api/assistant/threads',
  'GET /api/assistant/threads/:id',
  'POST /api/assistant/threads/:id/continue',
  'POST /api/assistant/threads/:id/summarize',
  'POST /api/assistant/read',
  'GET /api/assistant/conversations',
  'POST /api/assistant/transcribe',
];

export function isChatLoginRoute(method: string, pattern: string): boolean {
  return CHAT_LOGIN_ROUTES.includes(`${method.toUpperCase()} ${pattern}`);
}

/**
 * The Telegram pairing routes (workspaces W7d): every user pairs their own
 * Telegram chat with its code, lists and unpairs their own chats, and a
 * Moderator of a bot's workspace (or an Admin user with the users area)
 * lists, blocks and unpairs that bot's chats. They hold their own gate
 * (getChatLoginOr401, lib/agent-telegram.ts, @mantle/telegram pairing.ts):
 * a client is refused, every rule is in the query and names the login.
 * Proved per role in server/web/server/w7d-telegram.db.test.ts.
 */
export const TELEGRAM_LOGIN_ROUTES: readonly string[] = [
  'POST /api/telegram/pair',
  'GET /api/telegram/my-chats',
  'DELETE /api/telegram/my-chats/:id',
  'GET /api/telegram/moderated-chats',
  'POST /api/telegram/chats/:id/block',
  'POST /api/telegram/chats/:id/unpair',
];

/** A route every login reaches: ANY_LOGIN_ROUTES, the chat routes and the
 *  Telegram pairing routes. */
export function isAnyLoginRoute(method: string, pattern: string): boolean {
  const key = `${method.toUpperCase()} ${pattern}`;
  return (
    ANY_LOGIN_ROUTES.includes(key) ||
    CHAT_LOGIN_ROUTES.includes(key) ||
    TELEGRAM_LOGIN_ROUTES.includes(key)
  );
}
