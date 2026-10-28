/**
 * The client: one fetch per call, basic auth, the deadline, and the engine's
 * answers mapped to the package's errors (400, 401, 409, 413, 503, a network
 * failure, a timeout). The service gate comes first: off means 503 with the
 * switch named, and no request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServicesFileCache } from '@mantle/config';
import {
  callGotenberg,
  DocumentsBusyError,
  DocumentsFormError,
  DocumentsRenderError,
  DocumentsTooLargeError,
  DocumentsUnavailableError,
} from './client';
import { gotenbergHealth } from './health';

const route = { key: 'pdfengines/merge', path: '/forms/pdfengines/merge' };
const KEYS = [
  'GOTENBERG_URL',
  'GOTENBERG_PASSWORD',
  'MANTLE_COMPOSE_PROFILES',
  'MANTLE_UPDATE_SIGNAL_DIR',
] as const;
const saved: Record<string, string | undefined> = {};
const calls: { url: string; init: RequestInit }[] = [];

function answer(status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
      status,
      headers,
    });
  });
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.GOTENBERG_URL = 'http://gotenberg:3000/';
  process.env.GOTENBERG_PASSWORD = 'pw';
  delete process.env.MANTLE_COMPOSE_PROFILES;
  process.env.MANTLE_UPDATE_SIGNAL_DIR = '/nonexistent-signal-dir';
  resetServicesFileCache();
  calls.length = 0;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetServicesFileCache();
  vi.unstubAllGlobals();
});

describe('callGotenberg', () => {
  it('posts the form with basic auth and the output name, and reads the bytes', async () => {
    answer(200, Buffer.from('%PDF-1.4'), {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="report.pdf"',
    });
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array([1])]), 'a.pdf');
    const res = await callGotenberg(route, form, { outputName: 'report' });
    expect(res.bytes.toString()).toBe('%PDF-1.4');
    expect(res.contentType).toBe('application/pdf');
    expect(res.filename).toBe('report.pdf');
    expect(calls[0]?.url).toBe('http://gotenberg:3000/forms/pdfengines/merge');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('mantle:pw').toString('base64')}`);
    expect(headers['Gotenberg-Output-Filename']).toBe('report');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses with 503 and the switch when the service is off, and makes no request', async () => {
    process.env.MANTLE_COMPOSE_PROFILES = 'sandboxes';
    answer(200, 'x');
    await expect(callGotenberg(route, new FormData())).rejects.toBeInstanceOf(
      DocumentsUnavailableError,
    );
    await expect(callGotenberg(route, new FormData())).rejects.toThrow(/Settings > Services/);
    expect(calls).toHaveLength(0);
    delete process.env.MANTLE_COMPOSE_PROFILES;
    delete process.env.GOTENBERG_PASSWORD;
    await expect(callGotenberg(route, new FormData())).rejects.toThrow(/not available/);
    expect(calls).toHaveLength(0);
  });

  const cases: [number, string, new (...a: never[]) => Error, RegExp][] = [
    [
      400,
      'Invalid form data: no form file found for extensions: [.pdf]',
      DocumentsFormError,
      /no form file found/,
    ],
    [401, 'Unauthorized', DocumentsUnavailableError, /password/],
    [403, 'Forbidden', DocumentsRenderError, /refused the address/],
    [409, 'the main URL answered 403', DocumentsRenderError, /could not be rendered: the main URL/],
    [413, 'Request Entity Too Large', DocumentsTooLargeError, /too large/],
    [503, 'queue is full', DocumentsBusyError, /busy: queue is full/],
    [500, 'boom', DocumentsUnavailableError, /answered 500/],
  ];
  for (const [status, text, cls, why] of cases) {
    it(`maps ${status} to ${cls.name}`, async () => {
      answer(status, text);
      const err = await callGotenberg(route, new FormData()).catch((e: Error) => e);
      expect(err).toBeInstanceOf(cls);
      expect(String(err)).toMatch(why);
    });
  }

  it('bounds the engine error text to one line', async () => {
    answer(409, `${'x'.repeat(500)}\nsecond line`);
    const err = await callGotenberg(route, new FormData()).catch((e: Error) => e);
    expect((err as Error).message.length).toBeLessThan(400);
    expect((err as Error).message).not.toContain('\n');
  });

  it('a network failure is unavailable; a timeout is busy', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(callGotenberg(route, new FormData())).rejects.toBeInstanceOf(
      DocumentsUnavailableError,
    );
    vi.stubGlobal('fetch', async () => {
      const e = new Error('aborted');
      e.name = 'TimeoutError';
      throw e;
    });
    await expect(callGotenberg(route, new FormData())).rejects.toBeInstanceOf(DocumentsBusyError);
  });
});

describe('gotenbergHealth', () => {
  it('is neutral when unwired or off, up or down from /health, with the version', async () => {
    delete process.env.GOTENBERG_PASSWORD;
    expect(await gotenbergHealth()).toEqual({ up: null, version: null, modules: {} });
    process.env.GOTENBERG_PASSWORD = 'pw';
    process.env.MANTLE_COMPOSE_PROFILES = '';
    expect((await gotenbergHealth()).up).toBeNull();
    delete process.env.MANTLE_COMPOSE_PROFILES;
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/version')
        ? new Response('8.39.0\n', { status: 200 })
        : new Response(
            JSON.stringify({
              status: 'up',
              details: { chromium: { status: 'up' }, libreoffice: { status: 'up' } },
            }),
            { status: 200 },
          ),
    );
    expect(await gotenbergHealth()).toEqual({
      up: true,
      version: 'Gotenberg 8.39.0',
      modules: { chromium: 'up', libreoffice: 'up' },
    });
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/version')
        ? new Response('', { status: 401 })
        : new Response(
            JSON.stringify({
              status: 'down',
              details: { chromium: { status: 'up' }, libreoffice: { status: 'down', error: 'x' } },
            }),
            { status: 503 },
          ),
    );
    expect(await gotenbergHealth()).toEqual({
      up: false,
      version: null,
      modules: { chromium: 'up', libreoffice: 'down' },
    });
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect((await gotenbergHealth()).up).toBe(false);
  });
});
