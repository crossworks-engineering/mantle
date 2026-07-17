/**
 * Process liveness heartbeat — shared by the api runner and every worker.
 *
 * Workers and the api runner expose no HTTP port, and their container already
 * exits (the restart policy bounces it) if the process DIES. What that doesn't
 * catch is a WEDGED process: still running, event loop stalled, doing nothing.
 * A container-level healthcheck needs a signal it can read from outside the
 * process — so each service periodically touches a heartbeat file, and the
 * compose healthcheck asserts that file's mtime is fresh.
 *
 * Design point that matters: the interval measures EVENT-LOOP liveness, not
 * business progress. It just rewrites the file on a timer. A wedged DB
 * connection or an idle worker (nothing to do) keeps the loop healthy, so the
 * probe stays green — exactly right. Only a stalled/blocked event loop lets the
 * mtime go stale and trips the probe. The timer is `unref()`'d so it can never
 * keep an otherwise-dead process alive: if everything else stops, Node exits,
 * the heartbeat stops with it, the mtime goes stale, and Docker restarts the
 * container — same outcome as a hard crash, which is what we want.
 */

import { writeFile } from 'node:fs/promises';

const DEFAULT_HEARTBEAT_FILE = '/tmp/mantle-heartbeat';

/** Default touch interval. The compose probe treats a file older than ~90s as
 *  stale (3× this), so a single missed tick never flaps health. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Resolve the heartbeat file path (env override → per-container default under
 *  /tmp, which exists and is writable in every image and is NOT a shared mount,
 *  so two containers can never collide on it). */
export function heartbeatFilePath(): string {
  return (process.env.MANTLE_HEARTBEAT_FILE ?? '').trim() || DEFAULT_HEARTBEAT_FILE;
}

async function touchHeartbeat(file: string): Promise<void> {
  try {
    await writeFile(file, `${Date.now()}\n`);
  } catch {
    // A heartbeat write hiccup (full /tmp, transient EIO) must never disturb the
    // process it's monitoring — swallow and try again on the next tick.
  }
}

/**
 * Start touching the heartbeat file on an interval. Writes one immediately so a
 * freshly-booted container isn't racing its healthcheck start_period against an
 * absent file. Returns a stop function (for tests / graceful shutdown); the
 * timer is unref()'d so callers don't need to invoke it.
 */
export function startProcessHeartbeat(intervalMs: number = HEARTBEAT_INTERVAL_MS): () => void {
  const file = heartbeatFilePath();
  void touchHeartbeat(file);
  const timer = setInterval(() => void touchHeartbeat(file), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
