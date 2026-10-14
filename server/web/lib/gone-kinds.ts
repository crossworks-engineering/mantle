/**
 * The kinds of a retired route's 410 stub (lib/gone.ts `gone(kind)`, A4
 * hand batch A): who the removed route served, each to the caller kind the
 * gate answers for it (route-policy.ts RouteCaller) and the reader the stub
 * reads that answer with (eslint-rules/session-guards.mjs READER_ANSWERS).
 * The client portal's 'any' is the any-login guard's.
 *
 * The one table: lib/gone.ts reads with it, the route manifest generator
 * marks a stub's row with it (scripts/route-callers.ts) and the guard sweep
 * names a stub's entry with it (server/a4-guard-sweep.readers.ts). No
 * dependency here, so the generator can read it without loading the app.
 */
import type { RouteCaller } from './auth/route-policy';

export const GONE_KINDS = Object.freeze({
  owner: Object.freeze({ caller: 'owner', reader: 'ownerCaller' }),
  member: Object.freeze({ caller: 'member', reader: 'memberCaller' }),
  any: Object.freeze({ caller: 'login', reader: 'loginCaller' }),
} as const satisfies Record<string, { caller: RouteCaller; reader: string }>);

/** Who the removed route served. */
export type GoneGuard = keyof typeof GONE_KINDS;

/** Whether `kind` is a stub kind. */
export function isGoneGuard(kind: string): kind is GoneGuard {
  return Object.hasOwn(GONE_KINDS, kind);
}
