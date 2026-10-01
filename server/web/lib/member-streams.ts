/**
 * Open member realtime streams, per login (audit S8). One shared LISTEN
 * serves them all, so a stream costs no Postgres connection, but each is a
 * held socket and a subscriber: a login may hold a few (tabs, windows), not
 * any number.
 */

/** Open streams one login may hold. */
export const MEMBER_STREAMS_PER_LOGIN = 5;
/** A stream closes after this long, or when the session cookie expires if
 *  that is sooner; EventSource reconnects and so re-authenticates. */
export const MEMBER_STREAM_MAX_MS = 60 * 60 * 1000;

const open = new Map<string, number>();

/** Take a stream slot for a login: the release function, or null when the
 *  login already holds MEMBER_STREAMS_PER_LOGIN. Release is idempotent. */
export function takeMemberStream(loginId: string): (() => void) | null {
  const held = open.get(loginId) ?? 0;
  if (held >= MEMBER_STREAMS_PER_LOGIN) return null;
  open.set(loginId, held + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (open.get(loginId) ?? 1) - 1;
    if (n > 0) open.set(loginId, n);
    else open.delete(loginId);
  };
}

/** How long a new stream may live: an hour, or until the session expires. */
export function memberStreamLifetimeMs(sessionExpiryMs: number | null, now = Date.now()): number {
  const untilExpiry = sessionExpiryMs ? sessionExpiryMs - now : MEMBER_STREAM_MAX_MS;
  return Math.max(1_000, Math.min(MEMBER_STREAM_MAX_MS, untilExpiry));
}
