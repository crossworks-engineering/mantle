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
import { graphFetchRaw, graphGet, graphGetAll, type GraphError } from './client';

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
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [{ id: 'c' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [{ id: 'd' }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-final',
        }),
      );

    const { items, deltaLink } = await graphGetAll<{ id: string }>(
      'u1',
      'acc1',
      '/drives/d1/root/delta',
    );

    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(deltaLink).toBe('https://graph.microsoft.com/v1.0/delta-final');
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
        jsonResponse({
          value: [{ id: 'b' }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta',
        }),
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
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta' }),
    );
    const { items, deltaLink } = await graphGetAll('u1', 'acc1', '/drives/d1/root/delta');
    expect(items).toEqual([]);
    expect(deltaLink).toBe('https://graph.microsoft.com/v1.0/delta');
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

      const p = graphFetchRaw('https://graph.microsoft.com/v1.0/x', 'tok');
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
      const p = graphFetchRaw('https://graph.microsoft.com/v1.0/x', 'tok');
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
      await graphFetchRaw('https://graph.microsoft.com/v1.0/x', 'tok');
    } catch (e) {
      caught = e as GraphError;
    }
    expect(caught?.status).toBe(401);
    expect(caught?.message).toContain('401');
  });

  it('sends the bearer token and merges caller headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await graphFetchRaw('https://graph.microsoft.com/v1.0/x', 'tok', {
      headers: { Accept: 'application/json' },
    });
    const init = nth(nth(fetchMock.mock.calls, 0), 1) as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers.Accept).toBe('application/json');
  });
});

// Recorded before A10 #10 folded the loop into @mantle/std withRetry.
describe('graphFetchRaw backoff pins (A10 #10)', () => {
  async function gaps(responses: Response[]): Promise<{ gaps: number[]; err: unknown }> {
    vi.useFakeTimers();
    const at: number[] = [];
    let i = 0;
    fetchMock.mockImplementation(async () => {
      at.push(Date.now());
      return responses[Math.min(i++, responses.length - 1)]!;
    });
    try {
      const p = graphFetchRaw('https://graph.microsoft.com/v1.0/x', 'tok').then(
        () => null,
        (e: unknown) => e,
      );
      await vi.runAllTimersAsync();
      const err = await p;
      return { gaps: at.slice(1).map((t, n) => t - at[n]!), err };
    } finally {
      vi.useRealTimers();
    }
  }
  const tooMany = (ra?: string) =>
    jsonResponse('slow', { status: 429, headers: ra === undefined ? {} : { 'retry-after': ra } });

  it('doubles from 1 s without a Retry-After, four times, then throws the 429', async () => {
    const r = await gaps([tooMany()]);
    expect(r.gaps).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(r.err).toMatchObject({ status: 429 });
  });

  it('waits the Retry-After seconds when the header gives a positive number', async () => {
    const r = await gaps([tooMany('3'), tooMany('0'), tooMany('nonsense'), jsonResponse({})]);
    expect(r.gaps).toEqual([3_000, 2_000, 4_000]);
    expect(r.err).toBeNull();
  });
});

describe('the Graph host pin', () => {
  it('refuses a nextLink or any URL off graph.microsoft.com, before any request', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ value: [{ id: 'a' }], '@odata.nextLink': 'https://evil.example/steal' }),
    );
    await expect(graphGetAll('u1', 'acc1', '/me/messages')).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/refusing a Graph call off https:\/\/graph\.microsoft\.com/),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const u of [
      'https://graph.microsoft.com.evil.example/v1.0/x',
      'http://graph.microsoft.com/v1.0/x',
      'https://evil.example@graph.microsoft.com.evil.example/x',
    ]) {
      await expect(graphGet('u1', 'acc1', u), u).rejects.toMatchObject({ status: 400 });
    }
    await expect(graphFetchRaw('not a url', 'tok')).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
