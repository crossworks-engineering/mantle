/**
 * The listener's request deadlines.
 *
 * Node's http.Server gives a request 300 s (requestTimeout) to arrive in
 * full, headers and body, and then answers 408 and drops the socket. A
 * 451 MB upload from a home uplink (about 1.1 MB/s) died that way on dev
 * (2026-11-02): the server had read 335 MB at 309 s. The streamed upload cap
 * (MANTLE_MAX_UPLOAD_MB, default 512) is a patience number, so the deadline
 * follows it: the cap at a slow floor rate, never less than an hour.
 *
 * Why not 0 (as the parser has): the parser's slot holder bounds each body
 * itself, but here no route has a deadline of its own on the body's arrival,
 * so 0 would let a client trickle a body into any POST and hold the socket
 * for ever. A long fixed bound keeps that finite. The deadline covers the
 * request's arrival only: a long answer (an SSE stream, a download) is not
 * cut by it.
 *
 * headersTimeout stays at Node's 60 s, set here so a slow-header client
 * (slowloris) is bounded whatever requestTimeout is.
 */

/** The slowest uplink a full-size upload must still finish on: 128 KiB/s,
 *  about 1 Mbit/s. */
export const UPLOAD_FLOOR_BYTES_PER_SEC = 128 * 1024;
/** The deadline never drops under an hour, whatever the cap. */
export const MIN_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;
export const HEADERS_TIMEOUT_MS = 60_000;

/** The whole-request deadline for a streamed upload cap of `capBytes`. */
export function requestTimeoutFor(capBytes: number): number {
  const atFloor = Math.ceil((capBytes / UPLOAD_FLOOR_BYTES_PER_SEC) * 1000);
  return Math.max(MIN_REQUEST_TIMEOUT_MS, atFloor);
}

/** The part of http.Server the deadlines live on. */
export interface TimeoutTarget {
  requestTimeout: number;
  headersTimeout: number;
}

/** Sets the deadlines on the listener serve() returned. */
export function applyListenerTimeouts(server: TimeoutTarget, capBytes: number): void {
  server.requestTimeout = requestTimeoutFor(capBytes);
  server.headersTimeout = HEADERS_TIMEOUT_MS;
}
