/**
 * Open member realtime streams, per login. One shared LISTEN
 * serves them all, so a stream costs no Postgres connection, but each is a
 * held socket and a subscriber: a login may hold a few (tabs, windows), not
 * any number.
 */

/** Open streams one login may hold, of each kind. */
export const MEMBER_STREAMS_PER_LOGIN = 5;
/** The kinds of stream, each with its own slots: a client opens one of
 *  each per tab, so one kind must not use up the other's. */
export type MemberStreamKind = 'member' | 'messenger';
/** A stream closes after this long, or when the session cookie expires if
 *  that is sooner; EventSource reconnects and so re-authenticates. */
export const MEMBER_STREAM_MAX_MS = 60 * 60 * 1000;

const open = new Map<string, number>();

/** Take a stream slot of one kind for a login: the release function, or
 *  null when the login already holds MEMBER_STREAMS_PER_LOGIN of that
 *  kind. Release is idempotent. */
export function takeMemberStream(
  loginId: string,
  kind: MemberStreamKind = 'member',
): (() => void) | null {
  const key = `${kind}:${loginId}`;
  const held = open.get(key) ?? 0;
  if (held >= MEMBER_STREAMS_PER_LOGIN) return null;
  open.set(key, held + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (open.get(key) ?? 1) - 1;
    if (n > 0) open.set(key, n);
    else open.delete(key);
  };
}

/** How long a new stream may live: an hour, or until the session expires. */
export function memberStreamLifetimeMs(sessionExpiryMs: number | null, now = Date.now()): number {
  const untilExpiry = sessionExpiryMs ? sessionExpiryMs - now : MEMBER_STREAM_MAX_MS;
  return Math.max(1_000, Math.min(MEMBER_STREAM_MAX_MS, untilExpiry));
}
