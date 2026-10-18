/**
 * The request path behind a real listener (A10 part 2 fix round 1, H1).
 *
 * Every other HTTP test drives the app in-process (`app.request`), where the
 * handler's request is a real undici Request. Behind serve() it is not:
 * @hono/node-server hands the app a lightweight stand-in, which undici's
 * brand check refuses as the input of `new Request(req, init)`. The route
 * loader's body cap built its request that way, so every POST, PUT and PATCH
 * answered 500 on the real server while every in-process test passed.
 *
 * Here the app is served the way server/main.ts serves it
 * (`serve({ fetch, overrideGlobalObjects: false })`, on an ephemeral port)
 * and called over HTTP:
 *
 *  - stand-in routes through the loader and the app's error answer: a JSON
 *    POST, an empty POST, malformed JSON (400 invalid JSON), a chunked body
 *    over the ceiling (413 body-too-large), a multipart upload, a chunked
 *    multipart over its multipart ceiling (M3), a handler that wraps the
 *    ceiling's error and throws (L9), and a percent-encoded path held to the
 *    ceiling of the route that answers it (L8);
 *  - the whole app (createApp, the gate included): sign-out with a JSON,
 *    empty, malformed and form body (L4), a chunked body over the auth
 *    ceiling, a declared one on a percent-encoded path (L8, the gate), and a
 *    multipart upload as the owner.
 */
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { answerAppError } from './app-error';
import { registerRoutes, type RouteEntry } from './route-loader';
import {
  AUTH_BODY_CEILING_BYTES,
  JSON_BODY_CEILING_BYTES,
  MULTIPART_FRAMING_BYTES,
  VOICE_CLIP_BYTES,
} from '../lib/body-limit';
import { readBody, readJson } from '../lib/read-body';

// The whole-app half runs without a database: the login rows and the scope
// are stood in (as body-ceiling.test.ts does).
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
}));
vi.mock('../lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workspaces')>()),
  requireArea: async () => true,
}));

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const SPACE_ID = '66666666-6666-4666-8666-666666666666';
const MB = 1024 * 1024;

vi.mock('../lib/auth/login-row', () => ({
  loadLoginRow: async (id: string) =>
    id === OWNER_ID
      ? {
          id: OWNER_ID,
          email: 'owner@example.invalid',
          isOwner: true,
          displayName: null,
          role: 'admin',
          adminMember: true,
          contactId: null,
          disabledAt: null,
          sessionEpoch: 0,
        }
      : null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => SPACE_ID,
}));

/** Serve `app` as server/main.ts does, on an ephemeral port. */
async function listen(app: Hono): Promise<{ server: ServerType; base: string }> {
  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, port: 0, hostname: '127.0.0.1', overrideGlobalObjects: false },
      (info: AddressInfo) => resolve({ server, base: `http://127.0.0.1:${info.port}` }),
    );
  });
}

function close(server: ServerType | undefined): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

/** A body that declares no length and streams `bytes` in 64 KB chunks,
 *  starting with `head` (a multipart preamble). */
function chunked(bytes: number, head = ''): ReadableStream<Uint8Array> {
  let sent = 0;
  let first = true;
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  return new ReadableStream({
    pull(ctrl) {
      if (first && head) {
        first = false;
        ctrl.enqueue(new TextEncoder().encode(head));
        return;
      }
      if (sent >= bytes) return ctrl.close();
      ctrl.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
}

/**
 * POST a chunked body of `bytes` (after `head`) and resolve on the answer.
 *
 * A server that answers at the ceiling stops reading while the client still
 * writes; @hono/node-server drains what follows for a while and then closes
 * the socket, and a client still writing then may see a reset that takes the
 * answer with it (the same on main, where readBodyCapped stopped the same
 * way: it is the transport, not the cap). So the call is sent again on a
 * reset that came before any answer, up to `tries` times; an answer that
 * does arrive is the one asserted. node:http, not fetch, so the answer is
 * taken as it comes and a write error after it is ignored.
 */
async function postChunked(
  url: string,
  bytes: number,
  headers: Record<string, string> = {},
  head = '',
  tries = 10,
): Promise<{ status: number; body: string }> {
  for (let i = 1; ; i++) {
    try {
      return await postChunkedOnce(url, bytes, headers, head);
    } catch (err) {
      if (i >= tries || (err as { code?: string }).code !== 'ECONNRESET') throw err;
    }
  }
}

function postChunkedOnce(
  url: string,
  bytes: number,
  headers: Record<string, string> = {},
  head = '',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = httpRequest(url, { method: 'POST', headers }, (res) => {
      answered = true;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
      res.on('error', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', (err) => {
      if (!answered) reject(err);
    });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    if (head) req.write(head);
    const pump = () => {
      while (sent < bytes && !req.destroyed) {
        sent += chunk.byteLength;
        if (!req.write(chunk)) return void req.once('drain', pump);
      }
      if (!req.destroyed) req.end();
    };
    pump();
  });
}

const post = (url: string, init: RequestInit & { duplex?: 'half' } = {}) =>
  fetch(url, { method: 'POST', ...init } as RequestInit);

const entry = (pattern: string, POST: (req: Request) => Promise<Response>): RouteEntry => ({
  pattern,
  methods: ['POST'],
  catchAll: null,
  catchAllOptional: false,
  load: async () => ({ POST }),
});

describe('behind serve(): the loader and the error answer (stand-in routes)', () => {
  let server: ServerType | undefined;
  let base = '';

  beforeAll(async () => {
    const app = new Hono();
    registerRoutes(
      app,
      [
        entry('/api/echo', async (req) =>
          Response.json(await readBody(req, z.object({ a: z.number() }))),
        ),
        entry('/api/raw', async (req) => Response.json({ got: await readJson(req) })),
        // A multipart route with a multipart ceiling (the voice clip's).
        entry('/api/assistant/transcribe', async (req) => {
          const form = await req.formData().catch(() => null);
          if (!form)
            return Response.json({ error: 'expected multipart/form-data' }, { status: 400 });
          const file = form.get('audio');
          return Response.json({
            size: file instanceof Blob ? file.size : null,
            language: form.get('language'),
          });
        }),
        // A handler that wraps the ceiling's error in its own and throws (L9).
        entry('/api/wraps', async (req) => {
          try {
            await req.text();
          } catch {
            throw new Error('could not read the body');
          }
          return Response.json({ ok: true });
        }),
        // An auth route: the small ceiling (L8, by a percent-encoded path).
        entry('/api/auth/stand-in', async (req) => Response.json({ got: await readJson(req) })),
      ],
      new Map(),
    );
    app.onError(answerAppError);
    ({ server, base } = await listen(app));
  });
  afterAll(() => close(server));

  it('a JSON POST reads its body', async () => {
    const res = await post(`${base}/api/echo`, {
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('an empty POST reads as {}', async () => {
    const res = await post(`${base}/api/raw`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: {} });
  });

  it('malformed JSON is the one 400', async () => {
    const res = await post(`${base}/api/raw`, {
      headers: { 'content-type': 'application/json' },
      body: '{"a":',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid JSON' });
  });

  it('a chunked body over the ceiling is a 413 body-too-large', async () => {
    const res = await post(`${base}/api/raw`, {
      headers: { 'content-type': 'application/json' },
      body: chunked(JSON_BODY_CEILING_BYTES + MB),
      duplex: 'half',
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ reason: 'body-too-large' });
  });

  it('a multipart upload reads through formData()', async () => {
    const form = new FormData();
    form.set('audio', new Blob([new Uint8Array(3000)], { type: 'audio/webm' }), 'clip.webm');
    form.set('language', 'en');
    const res = await post(`${base}/api/assistant/transcribe`, { body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ size: 3000, language: 'en' });
  });

  it('a chunked multipart over its multipart ceiling is a 413 (M3)', async () => {
    const boundary = 'fx10boundary';
    const res = await postChunked(
      `${base}/api/assistant/transcribe`,
      VOICE_CLIP_BYTES + MULTIPART_FRAMING_BYTES + MB,
      { 'content-type': `multipart/form-data; boundary=${boundary}` },
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="a.webm"\r\n` +
        'Content-Type: audio/webm\r\n\r\n',
    );
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toMatchObject({ reason: 'body-too-large' });
  });

  it('a handler that wraps the ceiling error and throws still answers 413 (L9)', async () => {
    const res = await postChunked(`${base}/api/wraps`, JSON_BODY_CEILING_BYTES + MB);
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toMatchObject({ reason: 'body-too-large' });
    // Under the ceiling it answers as it does.
    expect((await post(`${base}/api/wraps`, { body: 'hi' })).status).toBe(200);
  });

  it('a percent-encoded path gets the ceiling of the route that answers it (L8)', async () => {
    // Over the auth ceiling, under the JSON one the raw spelling got before.
    const over = MB;
    expect(over).toBeGreaterThan(AUTH_BODY_CEILING_BYTES);
    expect(over).toBeLessThan(JSON_BODY_CEILING_BYTES);
    for (const path of ['/api/auth/stand-in', '/api/%61uth/stand-in']) {
      const res = await postChunked(`${base}${path}`, over);
      expect(res.status, path).toBe(413);
    }
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));

describe.skipIf(!hasManifest)('behind serve(): the whole app, as server/main.ts serves it', () => {
  const saved = process.env.SESSION_SECRET;
  let server: ServerType | undefined;
  let base = '';
  let ownerCookie = '';

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'serve-listener-secret-that-is-at-least-32-chars';
    const tokens = await import('../lib/auth/tokens');
    const { SESSION_COOKIE_NAME } = await import('../lib/auth-constants');
    ownerCookie = `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(OWNER_ID, { ttlSeconds: 3600 }).value}`;
    const { createApp } = await import('./app');
    ({ server, base } = await listen(await createApp()));
  }, 60_000);
  afterAll(async () => {
    await close(server);
    if (saved === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = saved;
  });

  it('sign-out answers 200 and clears the cookie, whatever the body (L4)', async () => {
    for (const [name, type, body] of [
      ['JSON', 'application/json', '{"everywhere":false}'],
      ['empty', null, undefined],
      ['malformed JSON', 'application/json', '{"everywhere":'],
      ['a form post', 'application/x-www-form-urlencoded', 'everywhere=true'],
    ] as const) {
      const res = await post(`${base}/api/auth/logout`, {
        headers: type ? { 'content-type': type } : {},
        body,
      });
      expect(res.status, name).toBe(200);
      expect(await res.json(), name).toEqual({ ok: true });
      expect(res.headers.get('set-cookie'), name).toMatch(/=;/);
    }
  });

  it('a chunked body over the auth ceiling is a 413', async () => {
    const res = await postChunked(`${base}/api/auth/logout`, MB, {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toMatchObject({ reason: 'body-too-large' });
  });

  it('the gate holds a percent-encoded path to its route ceiling (L8)', async () => {
    // A declared length over the auth ceiling: refused before any handler.
    for (const path of ['/api/auth/logout', '/api/%61uth/logout']) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(AUTH_BODY_CEILING_BYTES + 1024),
      });
      expect(res.status, path).toBe(413);
    }
  });

  it('a multipart upload reads through the capped request (owner photo)', async () => {
    const form = new FormData();
    // Not an image: the route reads the form, then refuses the bytes (415),
    // before any storage write.
    form.set('file', new Blob([new TextEncoder().encode('not an image')]), 'a.png');
    const res = await fetch(`${base}/api/profile/photo`, {
      method: 'PUT',
      headers: { cookie: ownerCookie },
      body: form,
    });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/^unsupported image/);
  });

  it('a chunked multipart over the voice clip ceiling is a 413 (M3)', async () => {
    const boundary = 'fx10boundary';
    const res = await postChunked(
      `${base}/api/assistant/transcribe`,
      VOICE_CLIP_BYTES + MULTIPART_FRAMING_BYTES + MB,
      { cookie: ownerCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="a.webm"\r\n\r\n`,
    );
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toMatchObject({ reason: 'body-too-large' });
  });
});
