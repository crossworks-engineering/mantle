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
  bodyCeilingFor,
  readBodyCapped,
} from '../lib/body-limit';
import { readJsonNoNul } from '../lib/strip-nul';

const CLIENT_ID = '12121212-1212-4212-8212-121212121212';
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
  contactId: null,
  disabledAt: null,
  sessionEpoch: 0,
});

vi.mock('../lib/auth/login-row', () => ({
  loadLoginRow: async (id: string) =>
    id === CLIENT_ID
      ? row(CLIENT_ID, 'client')
      : id === MEMBER_ID
        ? row(MEMBER_ID, 'member')
        : null,
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
  it('uploads have none; auth is small; owner documents are larger; the rest 8 MB', () => {
    for (const p of [
      '/api/files/files',
      '/api/client/space-files',
      '/api/member/space-files',
      '/api/admin/space-files',
      '/api/assistant/turn',
      '/api/tables/t1/import',
      '/api/apps/import-package',
      '/api/profile/photo',
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
    const { CLIENT_SESSION_TTL_SECONDS } = await import('../lib/auth/session');
    // A client's session has its own, shorter lifetime.
    cookie = (id) =>
      `${SESSION_COOKIE_NAME}=${
        tokens.buildSessionCookie(id, {
          ttlSeconds: id === CLIENT_ID ? CLIENT_SESSION_TTL_SECONDS : 3600,
        }).value
      }`;
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
    expect((await declared('/api/client/space-files', 15 * MB)).status).toBe(401);
    expect((await declared('/api/pages/p1/draft', 20 * MB)).status).toBe(401);
    expect((await declared('/api/pages/p1/draft', 200 * MB)).status).toBe(413);
  });

  it('a chunked body over the ceiling is a 413 once read (client and member routes)', async () => {
    for (const [path, id] of [
      ['/api/client/space', CLIENT_ID],
      ['/api/member/space', MEMBER_ID],
    ] as const) {
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
