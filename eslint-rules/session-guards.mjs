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

/** The readers of the caller the pipeline answers: a handler calls one in
 *  place of a guard. */
export const CALLER_READERS = Object.freeze(['ownerCaller']);
