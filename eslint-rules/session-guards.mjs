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
  'getReaderForAsset',
  'getSessionUserWithSource',
  'getSessionUser',
  'requireOwnerForRender',
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
 *    every Admin user (a declared caller: 'session', A4 hand batch A).
 *    A4 hand batch B: the asset guards (getOwnerForAsset,
 *    getReaderForAsset) the byte routes; the frame
 *    ticket the frame documents; and, answered at the read (`atRead`), the
 *    login a public row reads (getLoginOr401, getCookieUpgradeLoginOr401)
 *    and the owner of a row whose handler runs a key's checks first.
 *  - `guard`: the guard the reader replaced, whose answer it projects, as
 *    the guard sweep's recorded files name it (getOwnerOr401 and
 *    getOwnerOr401WithSource since they went: RETIRED_GUARDS); null for
 *    the frame ticket, which replaced no guard
 *    (the frame documents read none: the sweep logs no entry for it).
 *  - `entry`: the name the guard sweep logs the pipeline's answer under.
 *  - `atRead`: the gate binds the answer and the handler's first read runs
 *    it, where the handler called its guard (route-policy.ts
 *    ANSWERED_AT_READ): such a read may follow code, and is awaited.
 *    The Login readers (anyLoginCaller, ownerLoginCaller, chatCaller,
 *    publicLoginItself: plan v3.2 section 2.2) keep the entries of the
 *    legacy readers they replaced (S8d), and the guard sweep logs the
 *    answer in the legacy shape it rebuilds from the Login
 *    (a4-guard-sweep.test.ts), so the recorded files compare one answer
 *    byte for byte.
 */
export const READER_ANSWERS = Object.freeze({
  ownerCaller: Object.freeze({ caller: 'owner', guard: 'getOwnerOr401', entry: 'pipeline:owner' }),
  ownerCallerWithSource: Object.freeze({
    caller: 'owner',
    guard: 'getOwnerOr401WithSource',
    entry: 'pipeline:ownerWithSource',
  }),
  ownerLoginCaller: Object.freeze({
    caller: 'owner',
    guard: 'getOwnerOr401WithLogin',
    entry: 'pipeline:ownerWithLogin',
  }),
  memberCaller: Object.freeze({
    caller: 'member',
    guard: 'getMemberOr401',
    entry: 'pipeline:member',
  }),
  anyLoginCaller: Object.freeze({
    caller: 'login',
    guard: 'getLoginOr401',
    entry: 'pipeline:login',
  }),
  chatCaller: Object.freeze({
    caller: 'chat',
    guard: 'getChatLoginOr401',
    entry: 'pipeline:chat',
  }),
  sessionUserCaller: Object.freeze({
    caller: 'session',
    guard: 'getSessionUser',
    entry: 'pipeline:session',
  }),
  ownerAssetCaller: Object.freeze({
    caller: 'ownerAsset',
    guard: 'getOwnerForAsset',
    entry: 'pipeline:ownerAsset',
  }),
  readerAssetCaller: Object.freeze({
    caller: 'readerAsset',
    guard: 'getReaderForAsset',
    entry: 'pipeline:readerAsset',
  }),
  frameTicketCaller: Object.freeze({ caller: 'frame', guard: null, entry: 'pipeline:frame' }),
  publicLoginItself: Object.freeze({
    caller: 'publicLogin',
    guard: 'getLoginOr401',
    entry: 'pipeline:publicLogin',
    atRead: true,
  }),
  cookieUpgradeCaller: Object.freeze({
    caller: 'cookieUpgrade',
    guard: 'getCookieUpgradeLoginOr401',
    entry: 'pipeline:cookieUpgrade',
    atRead: true,
  }),
  ownerCallerAtRead: Object.freeze({
    caller: 'ownerAtRead',
    guard: 'getOwnerOr401',
    entry: 'pipeline:ownerAtRead',
    atRead: true,
  }),
});

/**
 * The guards session.ts no longer has, which a reader still names
 * (READER_ANSWERS `guard`): the guard sweep's recorded files spell the
 * answers of their rows under that name. getOwnerOr401 went at A4 exit
 * with getOwnerOr401WithSource (A4 hand batch B): every route reads the
 * caller the pipeline answers. requireOwner and requireOwnerWithSource went
 * too: nothing called them, and no reader names them.
 */
export const RETIRED_GUARDS = Object.freeze(['getOwnerOr401', 'getOwnerOr401WithSource']);

/** The readers' names (READER_ANSWERS). */
export const CALLER_READERS = Object.freeze(Object.keys(READER_ANSWERS));
