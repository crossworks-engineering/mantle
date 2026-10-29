/**
 * Thin Microsoft Graph fetch wrapper: bearer auth, throttling (429 +
 * Retry-After) backoff, and `@odata.nextLink` paging. Surfaces (drives, mail,
 * calendar — M1+) call through here so the cross-cutting concerns live in one
 * place. Token acquisition is the caller's job (see token-store) so the client
 * stays free of DB concerns and is trivially testable.
 */
import { getValidAccessToken } from './token-store';
import { backoffMs, parseRetryAfterMs, withRetry } from '@mantle/std';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
/** Every call that carries the token goes to this origin only. */
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const MAX_429_RETRIES = 4;

export interface GraphError extends Error {
  status: number;
}

function graphError(status: number, message: string): GraphError {
  const err = new Error(message) as GraphError;
  err.status = status;
  return err;
}

/** Low-level call against an absolute Graph URL with an already-resolved token.
 *  Honours 429 `Retry-After`; throws a `GraphError` (carrying the status) on
 *  any non-2xx so callers can branch on auth (401) vs throttling vs the rest.
 *  The URL must be on graph.microsoft.com: an absolute URL can come from
 *  Graph's own answer (`@odata.nextLink`, a stored `@odata.deltaLink`), and
 *  the bearer token goes nowhere else. */
export async function graphFetchRaw(
  url: string,
  accessToken: string,
  init?: RequestInit,
): Promise<Response> {
  let origin: string | null = null;
  try {
    origin = new URL(url).origin;
  } catch {
    // not a URL: refused below
  }
  if (origin !== GRAPH_ORIGIN) {
    throw graphError(400, `refusing a Graph call off ${GRAPH_ORIGIN}: ${url}`.slice(0, 500));
  }
  // A 429 waits the Retry-After seconds when Graph gives a positive number,
  // else 1, 2, 4, 8 s; MAX_429_RETRIES times, then the 429 throws below.
  const res = await withRetry(
    () =>
      fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
      }),
    {
      retries: MAX_429_RETRIES,
      isFailure: (r) => r.status === 429,
      delayMs: (retry, f) => {
        const retryAfter = parseRetryAfterMs(f.value?.headers);
        return retryAfter && retryAfter > 0 ? retryAfter : backoffMs(retry - 1, { baseMs: 1_000 });
      },
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw graphError(
      res.status,
      `Graph ${init?.method ?? 'GET'} ${url} → ${res.status}: ${body}`.slice(0, 500),
    );
  }
  return res;
}

/** Owner-scoped JSON GET. Resolves a fresh token for the account, then calls
 *  Graph. `path` is relative to the v1.0 base (e.g. `/me/drive/root/children`)
 *  or an absolute `@odata.nextLink`. */
export async function graphGet<T>(
  userId: string,
  accountId: string,
  pathOrUrl: string,
): Promise<T> {
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
