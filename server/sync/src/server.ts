/**
 * The Sync sidecar's HTTP face (M1: the skeleton). Two read-only routes:
 *
 *   GET /health  200 when the rclone binary ran at boot, else 503; compose's
 *                healthcheck and the updater's "on" wait read it.
 *   GET /status  what this sidecar is: rclone's version and the providers
 *                it serves (none yet: they come in M2 and later).
 *
 * Anything else is 404. Nothing here reads a secret or calls out.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type SyncState = {
  /** rclone's version at boot, or null when the binary did not run. */
  rclone: string | null;
};

export type SyncReply = { status: number; body: Record<string, unknown> };

/** The answer for one request, pure (the tests call it directly). */
export function syncReply(method: string, path: string, state: SyncState): SyncReply {
  if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };
  if (path === '/health') {
    return state.rclone
      ? { status: 200, body: { ok: true } }
      : { status: 503, body: { ok: false, error: 'rclone did not run' } };
  }
  if (path === '/status') {
    return {
      status: 200,
      body: { service: 'sync', rclone: state.rclone, providers: [] },
    };
  }
  return { status: 404, body: { error: 'not found' } };
}

export function createSyncServer(state: SyncState): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://sync').pathname;
    const reply = syncReply(req.method ?? 'GET', path, state);
    const body = JSON.stringify(reply.body);
    res.writeHead(reply.status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  });
}
