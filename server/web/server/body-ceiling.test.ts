/**
 * The request body ceiling (client logins C5 audit, I4), without a
 * database: a JSON body over its route's ceiling is a 413 `body-too-large`,
 *
 *  - by its declared Content-Length, in the gate, before any handler (and
 *    before auth: a stranger's huge body is not buffered either);
 *  - by the bytes actually read, for a chunked body that declares nothing
 *    (readJsonNoNul stops at the ceiling; app.onError answers 413);
 *
 * while uploads (their own streamed caps) and the owner document surfaces
 * (a larger ceiling) are not held to the JSON default.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AUTH_BODY_CEILING_BYTES,
  BodyTooLargeError,
  JSON_BODY_CEILING_BYTES,
  OWNER_DOCUMENT_CEILING_BYTES,
  SHARE_BODY_CEILING_BYTES,
  BUFFERED_UPLOAD_BYTES,
  MULTIPART_FRAMING_BYTES,
  PROFILE_IMAGE_BODY_BYTES,
  VOICE_CLIP_BYTES,
  bodyCeilingFor,
  bodyTooLargeResponse,
  bodyWentOver,
  capRequestBody,
  readBodyCapped,
} from '../lib/body-limit';
import { readJsonNoNul } from '../lib/strip-nul';
import { LOGO_MAX_BYTES } from '../lib/logo-validation';
import { MAX_UPLOAD_BYTES } from '@mantle/files';

// W6a: the session guard reads the login's workspaces (loginScopeFor) and,
// on a management route, its area (requireArea) from the database. This
// file runs without one: an empty scope and every area stand in (the scope
// itself is proved in w6a-route-sweep.db.test.ts).
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
}));
vi.mock('../lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workspaces')>()),
  requireArea: async () => true,
}));

const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const SPACE_ID = '66666666-6666-4666-8666-666666666666';
const MB = 1024 * 1024;

const row = (id: string, role: string) => ({
  id,
  email: `${role}@example.invalid`,
  isOwner: false,
  displayName: null,
  role,
  adminMember: role === 'admin',
  contactId: null,
  disabledAt: null,
  sessionEpoch: 0,
});

vi.mock('../lib/auth/login-row', () => ({
  loadLoginRow: async (id: string) => (id === MEMBER_ID ? row(MEMBER_ID, 'member') : null),
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => SPACE_ID,
}));

/** A body that declares no length and streams `bytes` in 64 KB chunks. */
function chunked(bytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  return new ReadableStream({
    pull(ctrl) {
      if (sent >= bytes) return ctrl.close();
      ctrl.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
}
const streamReq = (url: string, bytes: number, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: 'POST',
    headers,
    body: chunked(bytes),
    duplex: 'half',
  } as RequestInit);

describe('the body ceiling: which route gets which', () => {
  it('streamed uploads have none; auth is small; owner documents are larger; the rest 8 MB', () => {
    for (const p of [
      '/api/files/files',
      '/api/member/space-files',
      '/api/admin/space-files',
      '/api/apps/import-package',
    ]) {
      expect(bodyCeilingFor(p), p).toBeNull();
    }
    expect(bodyCeilingFor('/api/auth/client-code')).toBe(AUTH_BODY_CEILING_BYTES);
    // The public share routes (apps audit S2): anyone with a link posts there.
    for (const p of ['/s/tok/db-broker', '/s/tok/code', '/s/tok/evaluate']) {
      expect(bodyCeilingFor(p), p).toBe(SHARE_BODY_CEILING_BYTES);
    }
    for (const p of ['/api/pages/p1/draft', '/api/mcp', '/api/admin/space/i1/save']) {
      expect(bodyCeilingFor(p), p).toBe(OWNER_DOCUMENT_CEILING_BYTES);
    }
    for (const p of [
      '/api/client/space/i1/draft',
      '/api/client/chat',
      '/api/member/space/i1/save',
      '/api/member/chat',
      '/api/team-admin/clients',
      // Not an owner prefix by accident of spelling.
      '/api/pagesx',
    ]) {
      expect(bodyCeilingFor(p), p).toBe(JSON_BODY_CEILING_BYTES);
    }
    expect(JSON_BODY_CEILING_BYTES).toBe(8 * MB);
  });
});

describe('the body ceiling: the multipart routes (A10 part 2 fix round 1, M3)', () => {
  it('each formData() route is held to its file cap plus the framing', () => {
    expect(bodyCeilingFor('/api/assistant/turn')).toBe(
      BUFFERED_UPLOAD_BYTES + MULTIPART_FRAMING_BYTES,
    );
    expect(bodyCeilingFor('/api/tables/t1/import')).toBe(
      BUFFERED_UPLOAD_BYTES + MULTIPART_FRAMING_BYTES,
    );
    expect(bodyCeilingFor('/api/assistant/transcribe')).toBe(
      VOICE_CLIP_BYTES + MULTIPART_FRAMING_BYTES,
    );
    for (const p of ['/api/profile/photo', '/api/profile/logo']) {
      expect(bodyCeilingFor(p), p).toBe(PROFILE_IMAGE_BODY_BYTES);
    }
  });

  it('the numbers are the caps they stand for', () => {
    // The buffered upload cap (a chat attachment, a spreadsheet import).
    expect(BUFFERED_UPLOAD_BYTES).toBe(MAX_UPLOAD_BYTES);
    // The photo and logo routes refuse a declared body over twice the image cap.
    expect(PROFILE_IMAGE_BODY_BYTES).toBe(LOGO_MAX_BYTES * 2);
    // The JSON branch of the turn reads under the JSON ceiling, well inside.
    expect(JSON_BODY_CEILING_BYTES).toBeLessThan(BUFFERED_UPLOAD_BYTES);
  });
});

describe('the body ceiling: its words (A10 lows, part 2 #6)', () => {
  it('says KB below 1 MB and MB from there', async () => {
    const words = async (n: number) =>
      ((await bodyTooLargeResponse(n).json()) as { error: string }).error;
    expect(await words(AUTH_BODY_CEILING_BYTES)).toBe('This request is too large (at most 64 KB).');
    expect(await words(SHARE_BODY_CEILING_BYTES)).toBe('This request is too large (at most 1 MB).');
    expect(await words(JSON_BODY_CEILING_BYTES)).toBe('This request is too large (at most 8 MB).');
  });
});

describe('the body ceiling: reading', () => {
  it('stops a chunked body at the ceiling, and refuses a declared one before reading', async () => {
    await expect(readBodyCapped(streamReq('http://x/', 2 * MB), MB)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    const declared = new Request('http://x/', {
      method: 'POST',
      headers: { 'content-length': String(2 * MB) },
      body: 'x',
    });
    await expect(readBodyCapped(declared, MB)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(await readBodyCapped(streamReq('http://x/', 128 * 1024), MB)).toHaveLength(128 * 1024);
  });

  it('capRequestBody: every reader stops at the ceiling; under it, the body is as sent (A10 part 2)', async () => {
    for (const read of [
      (r: Request) => r.json(),
      (r: Request) => r.text(),
      (r: Request) => r.arrayBuffer(),
      (r: Request) => new Response(r.body).text(),
    ]) {
      const capped = capRequestBody(streamReq('http://x/', 2 * MB), MB);
      await expect(read(capped)).rejects.toBeInstanceOf(BodyTooLargeError);
      expect(bodyWentOver(capped)).toBe(true);
    }
    // A swallowed error still marks the request (the loader answers 413).
    const swallowed = capRequestBody(streamReq('http://x/', 2 * MB), MB);
    expect(await swallowed.json().catch(() => ({}))).toEqual({});
    expect(bodyWentOver(swallowed)).toBe(true);
    const ok = capRequestBody(
      new Request('http://x/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      }),
      MB,
    );
    expect(ok.method).toBe('POST');
    expect(ok.headers.get('content-type')).toBe('application/json');
    expect(await ok.json()).toEqual({ a: 1 });
    expect(bodyWentOver(ok)).toBe(false);
    const none = new Request('http://x/', { method: 'DELETE' });
    expect(capRequestBody(none, MB)).toBe(none);
  });

  it('readJsonNoNul reads at most the JSON ceiling; under it, it is JSON as before', async () => {
    await expect(
      readJsonNoNul(streamReq('http://x/', JSON_BODY_CEILING_BYTES + 64 * 1024)),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
    const ok = new Request('http://x/', { method: 'PUT', body: '﻿{"a":"b\\u0000c"}' });
    expect(await readJsonNoNul(ok)).toEqual({ a: 'bc' });
    expect(await readJsonNoNul(new Request('http://x/', { method: 'PUT', body: 'nope' }))).toBe(
      null,
    );
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));

describe.skipIf(!hasManifest)('the body ceiling: through the app', () => {
  const saved = process.env.SESSION_SECRET;
  let app: Hono;
  let cookie: (id: string) => string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'body-ceiling-secret-that-is-at-least-32-chars';
    const tokens = await import('../lib/auth/tokens');
    const { SESSION_COOKIE_NAME } = await import('../lib/auth-constants');
    cookie = (id) =>
      `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(id, { ttlSeconds: 3600 }).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
  }, 60_000);
  afterAll(() => {
    if (saved === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = saved;
  });

  const declared = (path: string, bytes: number, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(bytes), ...headers },
      body: '{}',
    });

  it('the gate refuses a declared body over the ceiling, before auth', async () => {
    for (const path of ['/api/client/space', '/api/member/space', '/api/client/chat']) {
      const res = await declared(path, 9 * MB);
      expect(res.status, path).toBe(413);
      expect(await res.json()).toMatchObject({ reason: 'body-too-large' });
    }
    // A public sign-in route has its own small ceiling.
    expect((await declared('/api/auth/client-code', 100 * 1024)).status).toBe(413);
    // So has a public share route (apps audit S2), before its handler runs.
    expect((await declared('/s/tok/db-broker', 2 * MB)).status).toBe(413);
    // Under the ceiling the request goes on (to auth: no session, 401).
    expect((await declared('/api/client/space', 7 * MB)).status).toBe(401);
    // An upload is not held to it; an owner document surface has more room.
    expect((await declared('/api/member/space-files', 15 * MB)).status).toBe(401);
    expect((await declared('/api/pages/p1/draft', 20 * MB)).status).toBe(401);
    expect((await declared('/api/pages/p1/draft', 200 * MB)).status).toBe(413);
  });

  it('a chunked body over the ceiling is a 413 once read (member routes)', async () => {
    // A member route that reads its body before any database work (the
    // member chat routes answer 410 since W7c without reading it).
    for (const [path, id] of [['/api/member/push/connect', MEMBER_ID]] as const) {
      const res = await app.request(
        streamReq(`http://localhost${path}`, JSON_BODY_CEILING_BYTES + 128 * 1024, {
          cookie: cookie(id),
          'content-type': 'application/json',
        }),
      );
      expect(res.status, path).toBe(413);
      expect(await res.json()).toMatchObject({ reason: 'body-too-large' });
    }
  });
});
