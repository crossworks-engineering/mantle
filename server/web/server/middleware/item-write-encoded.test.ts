/**
 * The item write check reads the DECODED item id (security fix): Hono
 * decodes the path before routing and hands the handler the decoded param,
 * so `PATCH /api/pages/%311111111-...` reaches the handler with a valid id.
 * The check took the id from the RAW path segment, failed its UUID test and
 * skipped itself, so a login could write an item it may only read (or not
 * see at all). Now the check runs on the id the handler gets, and a segment
 * that does not decode to an item id is refused (the 404 a non-Admin login
 * gets for an item it does not read), never skipped.
 *
 * Driven through the real gate middleware and route loader with real
 * manifest patterns (their real ROUTE_POLICY rows) and stub handlers that
 * call the session guard. No database: the login rows are stood in
 * (lib/auth/login-row), and the item check's queries are answered here
 * (`db.execute`), which also records the id each query was asked about.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteEntry } from '../route-loader';

const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const ITEM = '11111111-1111-4111-8111-111111111111';
/** The same id with its first character percent-encoded. */
const ENCODED = `%31${ITEM.slice(1)}`;

/** What the item check's queries answer, and what they were asked. */
const state = vi.hoisted(() => ({
  /** The item row in the login's scope (none: the login does not read it). */
  row: null as { edit: boolean; manage: boolean; copy: boolean } | null,
  /** Every parameter the queries were asked with. */
  asked: [] as unknown[],
}));

vi.mock('../../lib/auth/login-row', () => ({
  loadBearerToken: async () => null,
  touchBearerToken: async () => undefined,
  loadLoginRow: async (id: string) =>
    id === MEMBER_ID || id === ADMIN_ID
      ? {
          id,
          email: `${id === MEMBER_ID ? 'member' : 'admin'}@example.invalid`,
          isOwner: false,
          displayName: null,
          role: id === MEMBER_ID ? 'member' : 'admin',
          contactId: null,
          disabledAt: null,
          sessionEpoch: 0,
        }
      : null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => null,
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const dialect = new PgDialect();
  return {
    ...actual,
    brainOnWorkspacesNow: async () => true,
    loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
    withViewer: async (_viewer: unknown, fn: () => unknown) => fn(),
    // Past the item check (which a skipped check reaches), a create home
    // that names none: the write goes on as before.
    createHomeIntent: async () => ({ createWs: null, privateWs: null }),
    db: {
      execute: async (query: SQL) => {
        const { sql, params } = dialect.sqlToQuery(query);
        state.asked.push(...params);
        if (sql.includes('recall_revisions')) return [{ id: ITEM }];
        if (sql.includes('mantle_may_edit')) return state.row ? [state.row] : [];
        if (sql.includes('from nodes')) return state.row ? [{ '?column?': 1 }] : [];
        return [];
      },
    },
  };
});

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, '../route-manifest.gen.ts'));

describe.skipIf(!hasManifest)('the item write check reads the decoded item id', () => {
  const saved = { ...process.env };
  let app: Hono;
  let memberCookie: string;
  let adminCookie: string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'item-write-encoded-secret-that-is-at-least-32-chars';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_ADMIN_READS;
    const { buildSessionCookie } = await import('../../lib/auth/tokens');
    memberCookie = `mantle_session=${buildSessionCookie(MEMBER_ID).value}`;
    adminCookie = `mantle_session=${buildSessionCookie(ADMIN_ID).value}`;
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const { getOwnerOr401 } = await import('../../lib/auth/session');
    // The handler: the session guard, then what it was handed.
    const handler = async (_req: Request, ctx: { params: Promise<Record<string, unknown>> }) => {
      const owner = await getOwnerOr401();
      if (owner instanceof Response) return owner;
      return Response.json({ handled: true, id: (await ctx.params).id });
    };
    const routes: RouteEntry[] = [
      // Real manifest patterns: registerRoutes builds their real rows.
      { pattern: '/api/pages/:id', methods: ['PATCH'], load: async () => ({ PATCH: handler }) },
      { pattern: '/api/pages/:id/move', methods: ['POST'], load: async () => ({ POST: handler }) },
      {
        pattern: '/api/recall/revisions/:id/restore',
        methods: ['POST'],
        load: async () => ({ POST: handler }),
      },
      { pattern: '/api/v1/pages/:id', methods: ['PATCH'], load: async () => ({ PATCH: handler }) },
    ].map((r) => ({ catchAll: null, catchAllOptional: false, ...r }));
    app = new Hono();
    app.use('*', gate());
    registerRoutes(app, routes);
  });

  afterAll(() => {
    process.env = saved;
  });

  beforeEach(() => {
    state.row = null;
    state.asked = [];
  });

  const send = (method: string, path: string, cookie: string) =>
    app.request(path, { method, headers: { cookie, 'content-type': 'application/json' } });

  it('Hono hands the handler the decoded id (the premise)', async () => {
    state.row = { edit: true, manage: true, copy: false };
    const res = await send('PATCH', `/api/pages/${ENCODED}`, memberCookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handled: true, id: ITEM });
  });

  it('a member: an encoded id on an item route is checked as the decoded id', async () => {
    // The member does not read the item: the 404, before the handler.
    const res = await send('PATCH', `/api/pages/${ENCODED}`, memberCookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'not found' });
    expect(state.asked).toContain(ITEM);
    // It reads the item but may not edit it: the 403, before the handler.
    state.row = { edit: false, manage: false, copy: false };
    const ro = await send('PATCH', `/api/pages/${ENCODED}`, memberCookie);
    expect(ro.status).toBe(403);
    expect(await ro.json()).toMatchObject({ reason: 'item-workspace' });
  });

  it('a member: an encoded id on a manage route (a move) needs manage', async () => {
    state.row = { edit: true, manage: false, copy: false };
    const res = await send('POST', `/api/pages/${ENCODED}/move`, memberCookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'item-workspace' });
    expect(state.asked).toContain(ITEM);
  });

  it('a member: an encoded id on an item-ref route (a revision restore) is looked up decoded', async () => {
    state.row = { edit: false, manage: false, copy: false };
    const res = await send('POST', `/api/recall/revisions/${ENCODED}/restore`, memberCookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'item-workspace' });
    // The revision was looked up by the decoded id.
    expect(state.asked).toContain(ITEM);
  });

  it('an Admin user: an encoded id on a v1 route is checked as the decoded id', async () => {
    state.row = { edit: false, manage: false, copy: false };
    const res = await send('PATCH', `/api/v1/pages/${ENCODED}`, adminCookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'item-workspace' });
    expect(state.asked).toContain(ITEM);
  });

  it('a segment that does not decode to an item id is refused, never skipped', async () => {
    state.row = { edit: true, manage: true, copy: false };
    for (const seg of [
      // Not a UUID once decoded (encoded twice: the handler gets `%31...`).
      `%25${ENCODED.slice(1)}`,
      // Does not decode at all.
      `${ITEM.slice(0, -2)}%E0%A4`,
      // Not a UUID.
      'not-an-id',
    ]) {
      for (const cookie of [memberCookie, adminCookie]) {
        const res = await send('PATCH', `/api/pages/${seg}`, cookie);
        expect(res.status, seg).toBe(404);
        expect(await res.json(), seg).toEqual({ ok: false, error: 'not found' });
      }
    }
  });

  // Postgres reads each of these as the same uuid as ITEM, so a handler
  // that passed one to a uuid column would write that item. The check
  // takes only the canonical spelling (ITEM_ID_RE): each is refused with
  // the not-found answer before the handler, for every login, and no
  // query is asked about it.
  it('a UUID spelling Postgres accepts but the check does not is refused, never skipped', async () => {
    state.row = { edit: true, manage: true, copy: false };
    const hex = ITEM.replace(/-/g, '');
    const spellings = [
      // 32 hex digits, no hyphens.
      hex,
      // Braces, as sent (the URL parser escapes them) and escaped by hand.
      `{${ITEM}}`,
      `%7B${ITEM}%7D`,
      // Hyphens in other places (groups of eight, as Postgres takes them).
      `${hex.slice(0, 8)}-${hex.slice(8, 16)}-${hex.slice(16, 24)}-${hex.slice(24)}`,
      'a0eebc99-9c0b4ef8-bb6d6bb9-bd380a11',
    ];
    for (const seg of spellings) {
      for (const [path, cookie] of [
        [`/api/pages/${seg}`, memberCookie],
        [`/api/pages/${seg}`, adminCookie],
        [`/api/v1/pages/${seg}`, adminCookie],
        [`/api/pages/${seg}/move`, memberCookie],
      ] as const) {
        state.asked = [];
        const method = path.endsWith('/move') ? 'POST' : 'PATCH';
        const res = await send(method, path, cookie);
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.json(), `${method} ${path}`).toEqual({ ok: false, error: 'not found' });
        expect(state.asked, `${method} ${path}`).not.toContain(ITEM);
      }
    }
  });

  it('a plain id is checked as before', async () => {
    state.row = { edit: true, manage: false, copy: false };
    const ok = await send('PATCH', `/api/pages/${ITEM}`, memberCookie);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ handled: true, id: ITEM });
    state.row = { edit: false, manage: false, copy: false };
    const refused = await send('PATCH', `/api/pages/${ITEM}`, adminCookie);
    expect(refused.status).toBe(403);
  });
});
