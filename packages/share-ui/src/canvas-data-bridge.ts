/**
 * The host half of a canvas's `mantle.data` (DWG phase 7a): what CanvasSandbox
 * does with a `{v:1, kind:'data'}` message from its frame. Pure, so every
 * check is tested without a browser (canvas-data-bridge.test.ts).
 *
 * The frame is hostile. Its message is taken only from the document the
 * brain served this load (acceptsDataMessage: the frame's own window, after
 * its proof, carrying the proof's nonce), then checked field by field before
 * any request: a known operation, a known bucket, a key of the contract's
 * format, a value that is JSON text within the cap, a boolean `everyone`, a
 * login id for `by`.
 * Nothing in it names a canvas or a login: the request goes to THIS
 * sandbox's own canvas API (`apiBase`), with the host's own credential
 * (its fetcher), and the brain reads the login from that credential. Any
 * other field the message carries is ignored.
 */
import {
  isCanvasDataBucket,
  isCanvasDataKey,
  isCanvasDataLoginId,
  isCanvasDataOp,
  readCanvasDataJson,
  type CanvasDataOp,
} from '@mantle/content-core/canvas-data';

/** How many calls of one frame may wait on the brain at once: a canvas that
 *  asks more is answered at once with an error (the brain's rate limit is
 *  the bound across time). */
export const CANVAS_DATA_IN_FLIGHT_MAX = 8;

/**
 * Whether a `data` message may be forwarded at all: the frame has proved
 * itself this load (`ready` with the nonce), and the message carries that
 * same nonce (`n`). The nonce lives only in the served document's prelude
 * closure, so a page the frame navigated to (the same window, so the same
 * `e.source`) cannot send one, even in the moment before the host sees its
 * load.
 */
export function acceptsDataMessage(
  m: { n?: unknown } | null | undefined,
  state: { proven: boolean; nonce: string | null },
): boolean {
  return (
    !!m &&
    state.proven &&
    typeof state.nonce === 'string' &&
    state.nonce !== '' &&
    m.n === state.nonce
  );
}

/** The request a valid message becomes, relative to the canvas API base. */
export type CanvasDataRequest = {
  id: number;
  op: CanvasDataOp;
  method: 'GET' | 'PUT' | 'DELETE';
  /** `/data?…`, appended to the sandbox's own `apiBase`. */
  path: string;
  body?: string;
};

/** A message the host answers with an error (when it carries an id it can
 *  answer to) or drops. */
export type CanvasDataRejection = { id: number | null; error: string };

function idOf(m: Record<string, unknown>): number | null {
  const id = m.id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Read a frame's data message: the request to make, or why not. */
export function readCanvasDataMessage(
  raw: unknown,
): { ok: true; req: CanvasDataRequest } | { ok: false; rejection: CanvasDataRejection } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, rejection: { id: null, error: 'not a call' } };
  }
  const m = raw as Record<string, unknown>;
  const id = idOf(m);
  const no = (error: string) => ({ ok: false as const, rejection: { id, error } });
  if (id === null) return no('not a call');
  if (!isCanvasDataOp(m.op)) return no('unknown operation');
  const op = m.op;
  if (op === 'info') return { ok: true, req: { id, op, method: 'GET', path: '/data?info=1' } };
  if (op === 'clear') return { ok: true, req: { id, op, method: 'DELETE', path: '/data?all=1' } };

  const bucket = m.bucket;
  if (!isCanvasDataBucket(bucket)) return no("bucket must be 'shared' or 'mine'");
  if (op === 'list') {
    if (m.everyone !== undefined && typeof m.everyone !== 'boolean')
      return no('everyone must be true or false');
    const everyone = m.everyone === true && bucket === 'mine';
    const q = new URLSearchParams({ bucket });
    if (everyone) q.set('everyone', '1');
    return { ok: true, req: { id, op, method: 'GET', path: `/data?${q.toString()}` } };
  }
  if (!isCanvasDataKey(m.key)) {
    return no('key must be 1 to 128 letters, digits or _ - . : /, a letter or digit first');
  }
  const key = m.key;
  const q = new URLSearchParams({ bucket, key }).toString();
  if (op === 'get') return { ok: true, req: { id, op, method: 'GET', path: `/data?${q}` } };
  if (op === 'delete') {
    if (m.by === undefined || m.by === null) {
      return { ok: true, req: { id, op, method: 'DELETE', path: `/data?${q}` } };
    }
    if (bucket !== 'mine' || !isCanvasDataLoginId(m.by)) {
      return no("by must be a viewer's id (an entry's by.id), for the 'mine' bucket");
    }
    const qb = new URLSearchParams({ bucket, key, by: m.by }).toString();
    return { ok: true, req: { id, op, method: 'DELETE', path: `/data?${qb}` } };
  }
  // set
  const value = readCanvasDataJson(m.json);
  if (!value.ok) return no(value.error);
  return {
    ok: true,
    req: {
      id,
      op,
      method: 'PUT',
      path: '/data',
      body: `{"bucket":${JSON.stringify(bucket)},"key":${JSON.stringify(key)},"value":${value.text}}`,
    },
  };
}

/** What the frame is told for the brain's answer to `op`. */
export function canvasDataReply(
  op: CanvasDataOp,
  status: number,
  body: unknown,
): { ok: true; result: unknown } | { ok: false; error: string } {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (status >= 200 && status < 300) {
    switch (op) {
      case 'get':
        return { ok: true, result: b.entry ?? null };
      case 'list':
        return { ok: true, result: Array.isArray(b.entries) ? b.entries : [] };
      case 'info':
        return { ok: true, result: b.info ?? null };
      case 'set':
        return { ok: true, result: { updatedAt: b.updatedAt ?? null } };
      case 'delete':
        return { ok: true, result: { deleted: b.deleted === true } };
      case 'clear':
        return { ok: true, result: { removed: typeof b.removed === 'number' ? b.removed : 0 } };
    }
  }
  if (status === 404) return { ok: false, error: 'this canvas is not available' };
  if (status === 429) return { ok: false, error: 'too many calls: wait a moment and try again' };
  if (status === 401) return { ok: false, error: 'signed out: sign in again to save' };
  const said = typeof b.error === 'string' ? b.error.slice(0, 300) : '';
  return { ok: false, error: said || `the canvas data store failed (${status})` };
}
