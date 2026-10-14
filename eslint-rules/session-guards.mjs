/**
 * The session guards and the readers of the caller the pipeline answers
 * (server/web/lib/auth/session.ts; workspaces arch A4 step 3b): the one
 * list of their names. Each reads it from here:
 *
 *  - the route manifest generator (server/web/scripts/route-callers.ts): a
 *    handler that reads the caller calls no guard;
 *  - the guard sweep (server/web/server/a4-guard-sweep.test.ts): each guard
 *    is wrapped to record its answer;
 *  - the scoreboard (arch-counts.mjs): the guard calls it counts and the
 *    reads;
 *  - the reader's import rule (owner-caller-imports.mjs).
 *
 * eslint-rules/session-guards.test.ts pins the list to session.ts: every
 * name is a function it exports, and every function it exports named as a
 * guard (get... or require..., the Or401 and ForAsset forms) is here.
 */

/** The session guards: each resolves the caller itself. */
export const SESSION_GUARDS = Object.freeze([
  'getOwnerForAsset',
  'getMemberForAsset',
  'getReaderForAsset',
  'getSessionUserWithSource',
  'getSessionUser',
  'requireOwner',
  'requireOwnerForRender',
  'requireOwnerWithSource',
  'getOwnerOr401',
  'getOwnerOr401WithSource',
  'getOwnerOr401WithLogin',
  'getMemberOr401',
  'getLoginOr401',
  'getChatLoginOr401',
  'getCookieUpgradeLoginOr401',
]);

/**
 * The readers of the caller the pipeline answers, each to what it reads: a
 * handler calls one in place of a guard, and each projects the one answer
 * the gate gave (session.ts answerRouteCaller).
 *
 *  - `caller`: the row's caller kind the reader needs (route-policy.ts
 *    RouteCaller): the gate runs that kind's guard for the row. The owner
 *    guard serves the owner rows (self, content, area); the member guard
 *    the member list; the any-login guard the any-login list; the chat
 *    guard the chat and Telegram lists (A4 step 3b part 5); the session
 *    user's guard (getSessionUser: any Admin user, or null) the rows open to
 *    every Admin user (route-policy.ts ADMIN_OPEN_ROWS, A4 hand batch A).
 *  - `guard`: the guard the reader replaced, whose answer it projects.
 *  - `entry`: the name the guard sweep logs the pipeline's answer under.
 */
export const READER_ANSWERS = Object.freeze({
  ownerCaller: Object.freeze({ caller: 'owner', guard: 'getOwnerOr401', entry: 'pipeline:owner' }),
  ownerCallerWithSource: Object.freeze({
    caller: 'owner',
    guard: 'getOwnerOr401WithSource',
    entry: 'pipeline:ownerWithSource',
  }),
  ownerCallerWithLogin: Object.freeze({
    caller: 'owner',
    guard: 'getOwnerOr401WithLogin',
    entry: 'pipeline:ownerWithLogin',
  }),
  memberCaller: Object.freeze({
    caller: 'member',
    guard: 'getMemberOr401',
    entry: 'pipeline:member',
  }),
  loginCaller: Object.freeze({ caller: 'login', guard: 'getLoginOr401', entry: 'pipeline:login' }),
  chatLoginCaller: Object.freeze({
    caller: 'chat',
    guard: 'getChatLoginOr401',
    entry: 'pipeline:chat',
  }),
  sessionUserCaller: Object.freeze({
    caller: 'session',
    guard: 'getSessionUser',
    entry: 'pipeline:session',
  }),
});

/** The readers' names (READER_ANSWERS). */
export const CALLER_READERS = Object.freeze(Object.keys(READER_ANSWERS));
