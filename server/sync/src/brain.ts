/**
 * The sidecar's one road to the brain (Sync service plan M2): the brain's
 * /api/sidecar/* routes at SYNC_BRAIN_URL, with SYNC_TOKEN in
 * `x-mantle-sync-token`. The sidecar holds no database login and no master
 * key: its state, and the mail and events it fetched, go through here.
 *
 * No redirect is followed (the token must never reach another address).
 */
export const TOKEN_HEADER = 'x-mantle-sync-token';

const TIMEOUT_MS = 120_000;

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
};

export function createBrain(opts: { url: string; token: string }): Brain {
  const base = opts.url.replace(/\/+$/, '');
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        [TOKEN_HEADER]: opts.token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const error =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `the brain answered ${res.status}`;
      throw new BrainError(res.status, error);
    }
    return parsed as T;
  }
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    put: (path, body) => call('PUT', path, body),
    del: (path) => call('DELETE', path),
  };
}
