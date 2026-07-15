/**
 * Thin Microsoft Graph fetch wrapper: bearer auth, throttling (429 +
 * Retry-After) backoff, and `@odata.nextLink` paging. Surfaces (drives, mail,
 * calendar — M1+) call through here so the cross-cutting concerns live in one
 * place. Token acquisition is the caller's job (see token-store) so the client
 * stays free of DB concerns and is trivially testable.
 */
import { getValidAccessToken } from './token-store';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const MAX_429_RETRIES = 4;

export interface GraphError extends Error {
  status: number;
}

function graphError(status: number, message: string): GraphError {
  const err = new Error(message) as GraphError;
  err.status = status;
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Low-level call against an absolute Graph URL with an already-resolved token.
 *  Honours 429 `Retry-After`; throws a `GraphError` (carrying the status) on
 *  any non-2xx so callers can branch on auth (401) vs throttling vs the rest. */
export async function graphFetchRaw(url: string, accessToken: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
    });
    if (res.status === 429 && attempt < MAX_429_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw graphError(res.status, `Graph ${init?.method ?? 'GET'} ${url} → ${res.status}: ${body}`.slice(0, 500));
    }
    return res;
  }
}

/** Owner-scoped JSON GET. Resolves a fresh token for the account, then calls
 *  Graph. `path` is relative to the v1.0 base (e.g. `/me/drive/root/children`)
 *  or an absolute `@odata.nextLink`. */
export async function graphGet<T>(userId: string, accountId: string, pathOrUrl: string): Promise<T> {
  const token = await getValidAccessToken(userId, accountId);
  if (!token) throw graphError(401, 'no valid access token — account needs reconnect');
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const res = await graphFetchRaw(url, token, { headers: { Accept: 'application/json' } });
  return (await res.json()) as T;
}

/** Owner-scoped JSON POST. Returns the parsed JSON body, or `null` for the
 *  bodyless 202/204 responses Graph actions like `sendMail` reply with. */
export async function graphPost<T = unknown>(
  userId: string,
  accountId: string,
  path: string,
  body: unknown,
): Promise<T | null> {
  const token = await getValidAccessToken(userId, accountId);
  if (!token) throw graphError(401, 'no valid access token — account needs reconnect');
  const res = await graphFetchRaw(`${GRAPH_BASE}${path}`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 202 || res.status === 204) return null;
  return (await res.json()) as T;
}

interface GraphPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/** Follow `@odata.nextLink` to the end, accumulating `value[]`. For delta
 *  endpoints the terminal `@odata.deltaLink` is returned alongside so the
 *  caller can persist the cursor for next time. */
export async function graphGetAll<T>(
  userId: string,
  accountId: string,
  pathOrUrl: string,
): Promise<{ items: T[]; deltaLink: string | null }> {
  const items: T[] = [];
  let next: string | undefined = pathOrUrl;
  let deltaLink: string | null = null;
  while (next) {
    const page: GraphPage<T> = await graphGet<GraphPage<T>>(userId, accountId, next);
    if (Array.isArray(page.value)) items.push(...page.value);
    deltaLink = page['@odata.deltaLink'] ?? deltaLink;
    next = page['@odata.nextLink'];
  }
  return { items, deltaLink };
}
