/**
 * The sidecar's one road to the brain (Sync service plan M2): the brain's
 * /api/sidecar/* routes at SYNC_BRAIN_URL, with SYNC_TOKEN in
 * `x-mantle-sync-token`. The sidecar holds no database login and no master
 * key: its state, and the mail and events it fetched, go through here.
 *
 * No redirect is followed (the token must never reach another address).
 */
import { NET_TIMEOUTS, timeoutSignal } from '@mantle/std';

export const TOKEN_HEADER = 'x-mantle-sync-token';

export class BrainError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BrainError';
  }
}

export type Brain = {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
  /** POST a raw byte stream (a drive file, rclone cat): its JSON answer.
   *  `signal` aborts it (the stream's source failed). */
  stream<T>(path: string, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<T>;
};

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export function createBrain(opts: { url: string; token: string }): Brain {
  const base = opts.url.replace(/\/+$/, '');
  async function answer<T>(res: Response): Promise<T> {
    const text = await res.text();
    const parsed = parseJson(text);
    if (!res.ok) {
      const error =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `the brain answered ${res.status}`;
      throw new BrainError(res.status, error);
    }
    return parsed as T;
  }
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        [TOKEN_HEADER]: opts.token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: timeoutSignal(NET_TIMEOUTS.syncBrain),
    });
    return answer<T>(res);
  }
  return {
    stream: async (path, body, signal) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { [TOKEN_HEADER]: opts.token, 'content-type': 'application/octet-stream' },
        body,
        // A streamed request body (Bun and undici both take it).
        duplex: 'half',
        redirect: 'error',
        signal: AbortSignal.any([signal, timeoutSignal(NET_TIMEOUTS.syncFile)]),
      } as RequestInit);
      return answer(res);
    },
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    put: (path, body) => call('PUT', path, body),
    del: (path) => call('DELETE', path),
  };
}
