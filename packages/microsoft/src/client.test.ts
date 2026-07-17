import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Graph fetch wrapper — the seam every drive/mail/calendar sync calls
 * through. We pin the cross-cutting behaviour that governs how much data a sync
 * sees and where its cursor lands:
 *   - graphGetAll follows @odata.nextLink to the end, accumulating value[]
 *     across pages, and returns the terminal @odata.deltaLink (the cursor a
 *     drive sync persists — losing it would re-walk or skip on the next run);
 *   - graphFetchRaw retries 429s honouring Retry-After, then gives up, and
 *     throws a status-carrying GraphError on any non-2xx so callers can branch
 *     on 401 vs throttling.
 *
 * Seams: global fetch (HTTP boundary) and token-store (auth boundary) are
 * mocked; the wrapper's own logic is real.
 */

vi.mock('./token-store', () => ({
  getValidAccessToken: vi.fn(async () => 'access-token'),
}));

import { getValidAccessToken } from './token-store';
import { graphFetchRaw, graphGetAll, type GraphError } from './client';

const tokenMock = vi.mocked(getValidAccessToken);

/** Element `i`, narrowed (throws if absent) — for noUncheckedIndexedAccess. */
function nth<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected element ${i}`);
  return v;
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  tokenMock.mockClear();
  tokenMock.mockResolvedValue('access-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('graphGetAll', () => {
  it('follows nextLink across pages, accumulating value[] and capturing the final deltaLink', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          value: [{ id: 'a' }, { id: 'b' }],
          '@odata.nextLink': 'https://graph/next-1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ value: [{ id: 'c' }], '@odata.nextLink': 'https://graph/next-2' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ value: [{ id: 'd' }], '@odata.deltaLink': 'https://graph/delta-final' }),
      );

    const { items, deltaLink } = await graphGetAll<{ id: string }>(
      'u1',
      'acc1',
      '/drives/d1/root/delta',
    );

    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(deltaLink).toBe('https://graph/delta-final');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('resolves a relative first path against the Graph base but follows absolute nextLinks verbatim', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          value: [{ id: 'a' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/x?page=2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ value: [{ id: 'b' }], '@odata.deltaLink': 'https://graph/delta' }),
      );

    await graphGetAll('u1', 'acc1', '/drives/d1/root/delta');

    expect(nth(nth(fetchMock.mock.calls, 0), 0)).toBe(
      'https://graph.microsoft.com/v1.0/drives/d1/root/delta',
    );
    expect(nth(nth(fetchMock.mock.calls, 1), 0)).toBe('https://graph.microsoft.com/v1.0/x?page=2');
  });

  it('returns a null deltaLink when the feed never sends one (non-delta paging)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ value: [{ id: 'a' }] }));
    const { items, deltaLink } = await graphGetAll('u1', 'acc1', '/me/drive/root/children');
    expect(items).toHaveLength(1);
    expect(deltaLink).toBeNull();
  });

  it('tolerates a page with no value array (treats it as empty, not a crash)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ '@odata.deltaLink': 'https://graph/delta' }));
    const { items, deltaLink } = await graphGetAll('u1', 'acc1', '/drives/d1/root/delta');
    expect(items).toEqual([]);
    expect(deltaLink).toBe('https://graph/delta');
  });

  it('throws (does not swallow) when the account has no valid token', async () => {
    tokenMock.mockResolvedValueOnce(null);
    await expect(graphGetAll('u1', 'acc1', '/x')).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('graphFetchRaw', () => {
  it('retries a 429 honouring Retry-After, then returns the eventual success', async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse('slow down', { status: 429, headers: { 'retry-after': '1' } }),
        )
        .mockResolvedValueOnce(jsonResponse({ ok: true }, { status: 200 }));

      const p = graphFetchRaw('https://graph/x', 'tok');
      await vi.runAllTimersAsync();
      const res = await p;

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the retry budget and throws the 429 as a GraphError', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(
        jsonResponse('nope', { status: 429, headers: { 'retry-after': '1' } }),
      );
      const p = graphFetchRaw('https://graph/x', 'tok');
      const assertion = expect(p).rejects.toMatchObject({ status: 429 });
      await vi.runAllTimersAsync();
      await assertion;
      // MAX_429_RETRIES = 4 retries → 5 total attempts.
      expect(fetchMock).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws a GraphError carrying the status on a non-2xx (not a bare Error)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('unauthorized', { status: 401 }));
    let caught: GraphError | undefined;
    try {
      await graphFetchRaw('https://graph/x', 'tok');
    } catch (e) {
      caught = e as GraphError;
    }
    expect(caught?.status).toBe(401);
    expect(caught?.message).toContain('401');
  });

  it('sends the bearer token and merges caller headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await graphFetchRaw('https://graph/x', 'tok', { headers: { Accept: 'application/json' } });
    const init = nth(nth(fetchMock.mock.calls, 0), 1) as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers.Accept).toBe('application/json');
  });
});
