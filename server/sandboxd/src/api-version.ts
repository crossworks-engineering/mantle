/**
 * Docker Engine API version choice, kept pure so the clamp is testable without
 * a socket. docker.ts does the I/O (the unversioned `GET /version`); this file
 * only decides which `/v1.NN` prefix to speak.
 *
 * Why negotiate at all: the daemon's accepted range moves. Docker 29.0/29.1
 * raised the default MINIMUM to 1.44, so a client pinned to 1.43 got "client
 * version 1.43 is too old" on every call, `/healthz` went 503 and a fresh
 * install reported incomplete (2026-09-28). 29.5.2+ lowered it back to 1.40,
 * which is why older fleet boxes never noticed. Pinning either end is a bet
 * on a range we do not control.
 */

/** The version every call in docker.ts was written and tested against. */
export const PREFERRED_API_VERSION = '1.43';

/** Numeric compare of "major.minor" strings ("1.9" < "1.10", unlike floats). */
export function compareApiVersion(a: string, b: string): number {
  const [aMaj = 0, aMin = 0] = a.split('.').map(Number);
  const [bMaj = 0, bMin = 0] = b.split('.').map(Number);
  return aMaj - bMaj || aMin - bMin;
}

const isVersion = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d+$/.test(v);

/**
 * The preferred version clamped into the daemon's [min, max]. A bound the
 * daemon did not report (or reported malformed) is simply not applied.
 */
export function chooseApiVersion(
  daemon: { ApiVersion?: unknown; MinAPIVersion?: unknown },
  preferred: string = PREFERRED_API_VERSION,
): string {
  let v = preferred;
  if (isVersion(daemon.MinAPIVersion) && compareApiVersion(v, daemon.MinAPIVersion) < 0) {
    v = daemon.MinAPIVersion;
  }
  if (isVersion(daemon.ApiVersion) && compareApiVersion(v, daemon.ApiVersion) > 0) {
    v = daemon.ApiVersion;
  }
  return v;
}
