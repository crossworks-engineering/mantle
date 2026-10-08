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
import JSZip from 'jszip';
import { parseTikaBytes, tikaIsUp, tikaVersion, unpackTikaImages } from './tika';

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
type FakeResponse = {
  ok: boolean;
  status?: number;
  text?: string;
  /** Defaults to a Tika 4 raw answer for 2xx/422, JSON otherwise. */
  contentType?: string | null;
  retryAfter?: string;
  body?: Buffer;
};
function fakeResponse(response: FakeResponse): Response {
  const status = response.status ?? (response.ok ? 200 : 500);
  const contentType =
    response.contentType !== undefined
      ? response.contentType
      : response.ok || status === 422
        ? 'text/plain;charset=utf-8'
        : 'application/json';
  const headers = new Map<string, string>();
  if (contentType) headers.set('content-type', contentType);
  if (response.retryAfter) headers.set('retry-after', response.retryAfter);
  return {
    ok: response.ok,
    status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body: { cancel: async () => {} },
    text: async () => response.text ?? '',
    arrayBuffer: async () => {
      const b = response.body ?? Buffer.alloc(0);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  } as unknown as Response;
}
function mockFetch(...responses: FakeResponse[]): FetchSpy {
  let i = 0;
  const fetchSpy: FetchSpy = vi.fn(async () =>
    fakeResponse(responses[Math.min(i++, responses.length - 1)]!),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

describe('parseTikaBytes — URL resolution', () => {
  it('defaults to http://127.0.0.1:9998 when TIKA_URL is unset', async () => {
    const fetchSpy = mockFetch({ ok: true, text: 'hello' });
    await parseTikaBytes(Buffer.from('x'));
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://127.0.0.1:9998/tika/text');
  });

  it('honours TIKA_URL when set (prod compose: http://tika:9998)', async () => {
    process.env.TIKA_URL = 'http://tika:9998';
    const fetchSpy = mockFetch({ ok: true, text: 'hello' });
    await parseTikaBytes(Buffer.from('x'));
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://tika:9998/tika/text');
  });

  it('strips trailing slashes so we never produce //tika', async () => {
    process.env.TIKA_URL = 'http://tika:9998/';
    const fetchSpy = mockFetch({ ok: true, text: 'hello' });
    await parseTikaBytes(Buffer.from('x'));
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://tika:9998/tika/text');
  });

  it('falls back to default when TIKA_URL is whitespace-only', async () => {
    process.env.TIKA_URL = '   ';
    const fetchSpy = mockFetch({ ok: true, text: 'hello' });
    await parseTikaBytes(Buffer.from('x'));
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://127.0.0.1:9998/tika/text');
  });
});

describe('parseTikaBytes — request shape', () => {
  it('sends PUT to the Tika 4 text path, with no Accept routing', async () => {
    const fetchSpy = mockFetch({ ok: true, text: '' });
    await parseTikaBytes(Buffer.from('x'));
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('PUT');
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBeUndefined();
  });

  it('asks /tika/html for the structured rendering', async () => {
    const fetchSpy = mockFetch({ ok: true, text: '<html/>', contentType: 'text/html' });
    await parseTikaBytes(Buffer.from('x'), { accept: 'text/html' });
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://127.0.0.1:9998/tika/html');
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

describe('parseTikaBytes: Tika 3 fallback', () => {
  it('re-asks the 3.x way when /tika/text answers with a JSON envelope', async () => {
    const fetchSpy = mockFetch(
      { ok: true, text: '{"X-TIKA:content":"x"}', contentType: 'application/json' },
      { ok: true, text: 'plain text', contentType: 'text/plain' },
    );
    const text = await parseTikaBytes(Buffer.from('x'), { mimeType: 'application/rtf' });
    expect(text).toBe('plain text');
    expect(fetchSpy.mock.calls[1]![0]).toBe('http://127.0.0.1:9998/tika');
    const headers = (fetchSpy.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Accept).toBe('text/plain');
    expect(headers['Content-Type']).toBe('application/rtf');
  });

  it('re-asks the 3.x way on a 422 with no body type (3.x error shape)', async () => {
    const fetchSpy = mockFetch(
      { ok: false, status: 422, text: '', contentType: null },
      { ok: true, text: 'salvaged', contentType: 'text/plain' },
    );
    await expect(parseTikaBytes(Buffer.from('x'))).resolves.toBe('salvaged');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps the html rendering on the 3.x retry', async () => {
    const fetchSpy = mockFetch(
      { ok: true, text: '{}', contentType: 'application/json' },
      { ok: true, text: '<html/>', contentType: 'text/html' },
    );
    await parseTikaBytes(Buffer.from('x'), { accept: 'text/html' });
    const headers = (fetchSpy.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Accept).toBe('text/html');
  });

  it('does not fall back on a Tika 4 error status', async () => {
    const fetchSpy = mockFetch({ ok: false, status: 503, text: '{"status":"OOM"}' });
    await expect(parseTikaBytes(Buffer.from('x'))).resolves.toBe('');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('parseTikaBytes: Tika 4 backpressure', () => {
  it('waits out a 429 and asks again', async () => {
    const fetchSpy = mockFetch(
      {
        ok: false,
        status: 429,
        text: '{"status":"CLIENT_UNAVAILABLE_WITHIN_MS"}',
        retryAfter: '0',
      },
      { ok: true, text: 'served' },
    );
    await expect(parseTikaBytes(Buffer.from('x'))).resolves.toBe('served');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("gives up with '' when the wait would pass the deadline", async () => {
    const fetchSpy = mockFetch({ ok: false, status: 429, text: '{}', retryAfter: '30' });
    await expect(parseTikaBytes(Buffer.from('x'), { timeoutMs: 2_000 })).resolves.toBe('');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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

describe('parseTikaBytes — partial-success 422 salvage', () => {
  // Tika's SecureContentHandler throws a SAX exception on inputs that
  // expand past its zip-bomb ratio (~100:1 of input bytes → output chars).
  // It returns 422 but the body already carries what it streamed. Legit
  // case observed in the field: a valid EPUB whose 1 MB Lorem-ipsum body
  // compresses to 8.5 KB tripped the ratio and got silently discarded.
  it('salvages a non-empty body on status 422 (zip-bomb defense, real content present)', async () => {
    const salvageBody = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
    mockFetch({ ok: false, status: 422, text: salvageBody });
    const text = await parseTikaBytes(Buffer.from('x'));
    expect(text).toBe(salvageBody);
  });

  it('trims surrounding whitespace from a 422 body too', async () => {
    mockFetch({ ok: false, status: 422, text: '  partial parse  \n' });
    const text = await parseTikaBytes(Buffer.from('x'));
    expect(text).toBe('partial parse');
  });

  it("returns '' on 422 with an empty body (no useful text to salvage)", async () => {
    mockFetch({ ok: false, status: 422, text: '' });
    const text = await parseTikaBytes(Buffer.from('x'));
    expect(text).toBe('');
  });

  it("returns '' on 422 with whitespace-only body", async () => {
    mockFetch({ ok: false, status: 422, text: '   \n\t  ' });
    const text = await parseTikaBytes(Buffer.from('x'));
    expect(text).toBe('');
  });

  it('does NOT salvage on other 4xx (only 422 carries Tika partial output)', async () => {
    // 415 Unsupported Media Type, 413 Payload Too Large, etc. — those
    // statuses don't mean "parsed-with-warnings"; whatever body Tika
    // returns there is an error message, not extracted content.
    mockFetch({ ok: false, status: 415, text: 'Unsupported Media Type' });
    const text = await parseTikaBytes(Buffer.from('x'));
    expect(text).toBe('');
  });

  it('rejects a 422 body larger than MAX_PARTIAL_BODY_BYTES (zip-bomb shield)', async () => {
    // A true zip bomb would also trip Tika's defense and return 422. Cap
    // the salvage at 5 MB so an evil archive can't flood the LLM /
    // embedder with attacker-controlled text via this path.
    const oversized = 'x'.repeat(5_000_001);
    mockFetch({ ok: false, status: 422, text: oversized });
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

describe('unpackTikaImages', () => {
  const jpeg = (seed: number) => {
    const b = Buffer.alloc(4_096);
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b, 0);
    b.writeUInt32BE(seed, 2_000);
    return b;
  };
  const zipOf = async (files: Record<string, Buffer | string>) => {
    const zip = new JSZip();
    for (const [name, data] of Object.entries(files)) zip.file(name, data);
    return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
  };

  it('reads a Tika 4 archive: drops the container, sidecars and thumbnail, keeps numeric order', async () => {
    const meta = (m: Record<string, string>) => JSON.stringify(m);
    const body = await zipOf({
      '0.doc': Buffer.from('container'),
      '0.doc.metadata.json': meta({ 'tk:resource-name': 'memo.doc' }),
      '1.jpg': jpeg(1),
      '1.jpg.metadata.json': meta({
        'tk:embedded-id': '1',
        'tk:embedded-relationship-id': '/docProps/thumbnail.jpeg',
      }),
      '2.jpg': jpeg(2),
      '2.jpg.metadata.json': meta({ 'tk:embedded-id': '2', 'tk:resource-name': 'image2.jpg' }),
      '10.jpg': jpeg(10),
      '10.jpg.metadata.json': meta({ 'tk:embedded-id': '10', 'tk:resource-name': 'image10.jpg' }),
    });
    const fetchSpy = mockFetch({ ok: true, body, contentType: 'application/zip' });
    const images = await unpackTikaImages(Buffer.from('doc'), 'doc');
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://127.0.0.1:9998/unpack/all');
    expect(images.map((i) => i.bytes.readUInt32BE(2_000))).toEqual([2, 10]);
    expect(images.map((i) => i.ordinal)).toEqual([1, 2]);
  });

  it('still reads a Tika 3 archive', async () => {
    const body = await zipOf({
      __TEXT__: 'text',
      __METADATA__: 'meta',
      'docProps/thumbnail.jpeg': jpeg(1),
      'image1.jpg': jpeg(7),
    });
    mockFetch({ ok: true, body, contentType: 'application/zip' });
    const images = await unpackTikaImages(Buffer.from('doc'), 'doc');
    expect(images.map((i) => i.bytes.readUInt32BE(2_000))).toEqual([7]);
  });

  it('returns [] on a failed unpack', async () => {
    mockFetch({ ok: false, status: 503, text: '{"status":"TIMEOUT"}' });
    await expect(unpackTikaImages(Buffer.from('doc'), 'doc')).resolves.toEqual([]);
  });
});
