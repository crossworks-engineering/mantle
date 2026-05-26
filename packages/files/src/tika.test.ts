/**
 * Tests for the Tika client (`./tika.ts`).
 *
 * Two things matter for the wrapper's contract:
 *
 *   1. **URL resolution.** TIKA_URL env overrides DEFAULT_TIKA_URL; trailing
 *      slashes are stripped so we don't produce `…//tika`. Empty / whitespace
 *      env falls back to the default.
 *
 *   2. **Never-throws.** Every failure mode the wrapper documents — service
 *      down, timeout, non-2xx, malformed response — must return `''` (not
 *      throw, not reject). The whole point is that callers can rely on the
 *      empty-string contract to short-circuit to `no_text_layer` without
 *      try/catch boilerplate.
 *
 * Live "Tika actually parses an RTF" was verified out-of-band against the
 * running container during the rollout (commit log: smoke test PUT to
 * /tika returned the expected text); not re-running the actual service
 * here. These are the unit guarantees.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTikaBytes, tikaIsUp, tikaVersion } from './tika';

const ORIGINAL_TIKA_URL = process.env.TIKA_URL;

beforeEach(() => {
  // Wipe between tests so URL-resolution assertions are deterministic.
  delete process.env.TIKA_URL;
  vi.restoreAllMocks();
});

afterEach(() => {
  if (ORIGINAL_TIKA_URL == null) delete process.env.TIKA_URL;
  else process.env.TIKA_URL = ORIGINAL_TIKA_URL;
});

/** Helper: mock global fetch to capture the call + return a fake Response.
 *  Typed against `typeof fetch` so `mock.calls[i]` is `[input, init?]`, not
 *  the empty-tuple default of an untyped vi.fn(). */
type FetchSpy = ReturnType<typeof vi.fn<typeof fetch>>;
function mockFetch(response: { ok: boolean; status?: number; text?: string }): FetchSpy {
  const fetchSpy: FetchSpy = vi.fn(
    async () =>
      ({
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        text: async () => response.text ?? '',
      }) as unknown as Response,
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

describe('parseTikaBytes — URL resolution', () => {
  it('defaults to http://127.0.0.1:9998 when TIKA_URL is unset', async () => {
    const fetchSpy = mockFetch({ ok: true, text: 'hello' });
    await parseTikaBytes(Buffer.from('x'));
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://127.0.0.1:9998/tika');
  });

  it('honours TIKA_URL when set (prod compose: http://tika:9998)', async () => {
    process.env.TIKA_URL = 'http://tika:9998';
    const fetchSpy = mockFetch({ ok: true, text: 'hello' });
    await parseTikaBytes(Buffer.from('x'));
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://tika:9998/tika');
  });

  it('strips trailing slashes so we never produce //tika', async () => {
    process.env.TIKA_URL = 'http://tika:9998/';
    const fetchSpy = mockFetch({ ok: true, text: 'hello' });
    await parseTikaBytes(Buffer.from('x'));
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://tika:9998/tika');
  });

  it('falls back to default when TIKA_URL is whitespace-only', async () => {
    process.env.TIKA_URL = '   ';
    const fetchSpy = mockFetch({ ok: true, text: 'hello' });
    await parseTikaBytes(Buffer.from('x'));
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://127.0.0.1:9998/tika');
  });
});

describe('parseTikaBytes — request shape', () => {
  it('sends PUT with Accept: text/plain', async () => {
    const fetchSpy = mockFetch({ ok: true, text: '' });
    await parseTikaBytes(Buffer.from('x'));
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('PUT');
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe('text/plain');
  });

  it('sends Content-Type when mimeType is provided', async () => {
    const fetchSpy = mockFetch({ ok: true, text: '' });
    await parseTikaBytes(Buffer.from('x'), { mimeType: 'application/vnd.oasis.opendocument.text' });
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/vnd.oasis.opendocument.text');
  });

  it('omits Content-Type when mimeType is not provided (Tika auto-detects)', async () => {
    const fetchSpy = mockFetch({ ok: true, text: '' });
    await parseTikaBytes(Buffer.from('x'));
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('trims surrounding whitespace from the response body', async () => {
    mockFetch({ ok: true, text: '  hello world  \n\n' });
    const text = await parseTikaBytes(Buffer.from('x'));
    expect(text).toBe('hello world');
  });
});

describe('parseTikaBytes — never-throws contract', () => {
  it("returns '' on a non-2xx response", async () => {
    mockFetch({ ok: false, status: 500, text: 'Server Error' });
    const text = await parseTikaBytes(Buffer.from('x'));
    expect(text).toBe('');
  });

  it("returns '' on fetch rejection (network / Tika down)", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const text = await parseTikaBytes(Buffer.from('x'));
    expect(text).toBe('');
  });

  it("returns '' on an AbortError (timeout path)", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    );
    const text = await parseTikaBytes(Buffer.from('x'), { timeoutMs: 1 });
    expect(text).toBe('');
  });

  it("returns '' on a 4xx with empty body", async () => {
    mockFetch({ ok: false, status: 415, text: '' });
    const text = await parseTikaBytes(Buffer.from('x'));
    expect(text).toBe('');
  });
});

describe('tikaIsUp', () => {
  it('returns true on /version 2xx', async () => {
    const fetchSpy = mockFetch({ ok: true, text: 'Apache Tika 3.3.0' });
    await expect(tikaIsUp()).resolves.toBe(true);
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://127.0.0.1:9998/version');
  });

  it('returns false on a non-2xx', async () => {
    mockFetch({ ok: false, status: 503, text: '' });
    await expect(tikaIsUp()).resolves.toBe(false);
  });

  it('returns false on a fetch rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(tikaIsUp()).resolves.toBe(false);
  });
});

describe('tikaVersion', () => {
  it('returns the trimmed version string on 2xx', async () => {
    mockFetch({ ok: true, text: '  Apache Tika 3.3.0\n' });
    await expect(tikaVersion()).resolves.toBe('Apache Tika 3.3.0');
  });

  it('returns null on a non-2xx', async () => {
    mockFetch({ ok: false, status: 500, text: 'fail' });
    await expect(tikaVersion()).resolves.toBeNull();
  });

  it('returns null on an empty response body', async () => {
    mockFetch({ ok: true, text: '   ' });
    await expect(tikaVersion()).resolves.toBeNull();
  });

  it('returns null on a fetch rejection (Tika down)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(tikaVersion()).resolves.toBeNull();
  });
});
