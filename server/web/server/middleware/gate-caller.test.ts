/**
 * The caller the pipeline answers (arch A4 step 3b), driven through the
 * real gate and route loader with real manifest patterns and stub
 * handlers. Each route is served twice, by two apps: one whose handler
 * reads the pipeline's answer (ownerCaller(), the row's `caller`), one
 * whose handler calls the guard (getOwnerOr401's answer), as before. For every
 * credential both give the same answer: the status and body, the owner,
 * the actor the request runs as, what was done with its scope, the audit
 * row of a write, the device token's stamp. Only where it runs differs: a
 * refusal is the gate's, and the handler does not run.
 *
 * Self rows (batch 1 of the codemod), and a content read and an area row,
 * which the same step answers when their batches come.
 *
 * No database: the login rows come from a stand-in.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { actorSetting, currentActor, currentCreateHome, currentRequestOutcome } from '@mantle/db';
import { NextResponse } from '../http-compat';
import type { RouteEntry } from '../route-loader';
import type { RouteCaller } from '../../lib/auth/route-policy';

/** What getOwnerOr401 answered before it went (A4 exit): the owner guard's
 *  user, or its refusal. */
async function ownerGuard(): Promise<import('../../lib/auth/session').SessionUser | Response> {
  const { getOwnerOr401WithLogin } = await import('../../lib/auth/session');
  const got = await getOwnerOr401WithLogin();
  return got instanceof Response ? got : got.user;
}

const ADMIN = '55555555-5555-4555-8555-555555555555';
const ANCHOR = '33333333-3333-4333-8333-333333333333';
const MEMBER = '22222222-2222-4222-8222-222222222222';
/** An admin that holds no Admin area. */
const LIMITED = '44444444-4444-4444-8444-444444444444';

const counts = vi.hoisted(() => ({
  touches: 0,
  /** An error the device token's stamp throws (the database). */
  touchThrows: null as Error | null,
  handled: 0,
  audits: [] as string[],
  /** An error the audit row throws (the owner answer failing). */
  auditThrows: null as Error | null,
  bearers: new Map<string, { userId: string; revokedAt: Date | null; expiresAt: Date }>(),
  /** What each db.execute of the item-write check finds, in order (none:
   *  no row). */
  exec: [] as unknown[][],
  /** What the create-home intent answers. */
  home: { createWs: null, privateWs: null } as Record<string, unknown>,
}));

vi.mock('../../lib/auth/login-row', () => {
  const row = (id: string, role: 'admin' | 'member', isOwner = false) => ({
    id,
    email: `${role}@example.invalid`,
    isOwner,
    displayName: null,
    role,
    contactId: null,
    disabledAt: null,
    sessionEpoch: 0,
  });
  return {
    loadLoginRow: async (id: string) =>
      id === ANCHOR
        ? row(ANCHOR, 'admin', true)
        : id === ADMIN || id === LIMITED
          ? row(id, 'admin')
          : id === MEMBER
            ? row(MEMBER, 'member')
            : null,
    loadAnchorId: async () => ANCHOR,
    loadPersonalSpaceId: async () => null,
    loadBearerToken: async (jti: string) => counts.bearers.get(jti) ?? null,
    touchBearerToken: async () => {
      if (counts.touchThrows) throw counts.touchThrows;
      counts.touches += 1;
    },
  };
});
vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  // The item-write check's statements (the item a write names, what the
  // login may do to it) answer from counts.exec; withViewer runs its
  // function; the create-home intent answers counts.home.
  const db = new Proxy(real.db, {
    get: (t, k) => (k === 'execute' ? async () => counts.exec.shift() ?? [] : Reflect.get(t, k)),
  });
  return {
    ...real,
    db,
    withViewer: ((_actsFor, fn) => fn()) as typeof real.withViewer,
    createHomeIntent: (async () => counts.home) as unknown as typeof real.createHomeIntent,
    loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
    brainOnWorkspacesNow: async () => true,
  };
});
vi.mock('../../lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/workspaces')>()),
  requireArea: async (caller: { loginId: string }) => caller.loginId !== LIMITED,
}));
vi.mock('../../lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/audit')>()),
  auditFireAndForget: (e: { action: string; method?: string; path?: string; actorId: string }) => {
    if (counts.auditThrows) throw counts.auditThrows;
    counts.audits.push(`${e.action} ${e.method ?? ''} ${e.path ?? ''} ${e.actorId}`);
  },
}));

// The API keys (the guard sweep's): verified by their token, every budget
// open.
vi.mock('../../lib/access-keys', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/access-keys')>();
  const { KEY_GRANTS } = await import('../a4-guard-sweep.keys');
  const open = { ok: true as const, remaining: 1, retryAfterSec: 0 };
  return {
    ...real,
    verifyAccessKey: async (token: string) => {
      const grant = KEY_GRANTS[token];
      return grant ? { ok: true as const, grant } : { ok: false as const, reason: 'unknown' };
    },
    rateLimitAccessKey: () => open,
    rateLimitKeySearch: () => open,
    failedKeyBudget: () => open,
    countFailedKey: () => undefined,
    touchAccessKey: () => undefined,
    auditKeyRefusal: () => undefined,
  };
});

/** A manifest entry's `reads` where each method reads the owner caller. */
const ownerReads = (methods: readonly string[]) =>
  Object.fromEntries(methods.map((m) => [m, 'owner' as const]));

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, '../route-manifest.gen.ts'));

/** What a handler sees once it has its owner. */
function seen(owner: unknown) {
  const actor = currentActor();
  const out = currentRequestOutcome();
  return {
    owner,
    actor: actor ? actorSetting(actor) : null,
    out: out ? JSON.stringify(out) : null,
    home: currentCreateHome(),
  };
}

describe.skipIf(!hasManifest)('the caller the pipeline answers (A4 step 3b)', () => {
  const saved = { ...process.env };
  let pipeline: Hono;
  let guarded: Hono;
  let creds: Array<{ name: string; headers: () => Record<string, string> }>;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'gate-caller-test-secret-at-least-32-characters';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    const tokens = await import('../../lib/auth/tokens');
    const { SESSION_COOKIE_NAME } = await import('../../lib/auth-constants');
    const cookie = (id: string) => () => ({
      cookie: `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(id).value}`,
    });
    let n = 0;
    const bearer = (id: string, revoked = false) => {
      n += 1;
      const jti = `0000000${n}-0000-4000-8000-00000000000${n}`;
      const t = tokens.buildMobileToken(id, jti, 3600, 0);
      counts.bearers.set(jti, {
        userId: id,
        revokedAt: revoked ? new Date() : null,
        expiresAt: t.expiresAt,
      });
      return () => ({ authorization: `Bearer ${t.value}` });
    };
    creds = [
      { name: 'owner-cookie', headers: cookie(ANCHOR) },
      { name: 'admin-cookie', headers: cookie(ADMIN) },
      { name: 'limited-cookie', headers: cookie(LIMITED) },
      { name: 'member-cookie', headers: cookie(MEMBER) },
      { name: 'gone-cookie', headers: cookie('99999999-9999-4999-8999-999999999999') },
      { name: 'admin-bearer', headers: bearer(ADMIN) },
      { name: 'member-bearer', headers: bearer(MEMBER) },
      { name: 'revoked-bearer', headers: bearer(ADMIN, true) },
      // An Admin user without the area, by device token (A4 step 3b part
      // 4: the gate's Admin step refuses it after the stamp).
      { name: 'limited-bearer', headers: bearer(LIMITED) },
    ];
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const session = await import('../../lib/auth/session');
    const reads = async () => {
      counts.handled += 1;
      return Response.json(seen(session.ownerCaller()));
    };
    const guards = async () => {
      counts.handled += 1;
      const owner = await ownerGuard();
      if (owner instanceof Response) return owner;
      return Response.json(seen(owner));
    };
    // Real manifest patterns, so registerRoutes builds their real rows.
    const entries = (handle: () => Promise<Response>, read: boolean): RouteEntry[] =>
      [
        // Self rows (batch 1): a read and a write.
        { pattern: '/api/profile', methods: ['GET', 'PUT'] },
        // A content read a member may make, and an area row (users).
        { pattern: '/api/notes', methods: ['GET', 'POST'] },
        { pattern: '/api/users', methods: ['GET'] },
        // An area write (the assistants area).
        { pattern: '/api/agents/:id', methods: ['PATCH'] },
        // Content writes (batch 3): an item write, a create, and the read
        // POST whose guard checks the item as a write.
        { pattern: '/api/notes/:id', methods: ['PATCH', 'DELETE'] },
        { pattern: '/api/formulas/:id/evaluate', methods: ['POST'] },
        // More of batch 3's writes (A4 step 3b part 4, the part 3 audit):
        // the v1 alias of a create (an API key's write), an item write that
        // needs manage, an item named through a share, a Recall revision and
        // a deleted app's snapshot, and an app's data write (its item read:
        // the app; D6's Informational switch is the database's, after the
        // gate).
        { pattern: '/api/v1/notes', methods: ['POST'] },
        { pattern: '/api/pages/:id/move', methods: ['POST'] },
        { pattern: '/api/shares/:id', methods: ['DELETE'] },
        { pattern: '/api/recall/revisions/:id/restore', methods: ['POST'] },
        { pattern: '/api/apps/deleted/:id', methods: ['DELETE'] },
        { pattern: '/api/apps/:id/db-broker', methods: ['POST'] },
      ].map((e) => ({
        ...e,
        catchAll: null,
        catchAllOptional: false,
        ...(read ? { reads: ownerReads(e.methods) } : {}),
        load: async () => Object.fromEntries(e.methods.map((m) => [m, handle])),
      }));
    // The app's error path (server/app.ts onError): busy is a 409, the
    // rest an opaque 500.
    const { BUSY_MESSAGE, isBusy } = await import('@mantle/db');
    const onError = (err: Error) =>
      isBusy(err)
        ? Response.json({ error: BUSY_MESSAGE }, { status: 409 })
        : Response.json({ error: 'internal error' }, { status: 500 });
    pipeline = new Hono();
    pipeline.use('*', gate());
    registerRoutes(pipeline, entries(reads, true));
    pipeline.onError(onError);
    guarded = new Hono();
    guarded.use('*', gate());
    registerRoutes(guarded, entries(guards, false), { standIn: true });
    guarded.onError(onError);
  });

  afterAll(() => {
    process.env = saved;
  });

  beforeEach(() => {
    counts.touches = 0;
    counts.handled = 0;
    counts.audits.length = 0;
  });

  /** One request: its answer and what it did on the side. */
  async function drive(app: Hono, method: string, path: string, headers: Record<string, string>) {
    counts.touches = 0;
    counts.handled = 0;
    counts.audits.length = 0;
    const res = await app.request(path, { method, headers });
    return {
      status: res.status,
      type: res.headers.get('content-type'),
      cache: res.headers.get('cache-control'),
      body: await res.text(),
      touches: counts.touches,
      audits: [...counts.audits],
      handled: counts.handled,
    };
  }

  it('answers every credential as the guard does, on each row', async () => {
    const AGENT = '/api/agents/11111111-1111-4111-8111-111111111111';
    const cells: Array<[string, string]> = [
      ['GET', '/api/profile'],
      ['HEAD', '/api/profile'],
      ['PUT', '/api/profile'],
      ['GET', '/api/notes'],
      ['GET', '/api/users'],
      // An area write (part 4 fix round): its audit row is the gate's on
      // one app and the guard's on the other; a doubled or missing row
      // differs. (POST /api/users logs its own event: no api.write row.)
      ['PATCH', AGENT],
    ];
    let refused = 0;
    let areaWriteAudits = 0;
    for (const [method, path] of cells) {
      for (const cred of creds) {
        const a = await drive(pipeline, method, path, cred.headers());
        const b = await drive(guarded, method, path, cred.headers());
        const label = `${method} ${path} ${cred.name}`;
        // Where it runs: the gate refuses before the handler; the guard
        // refused inside it.
        if (a.status >= 400) {
          refused += 1;
          expect(a.handled, label).toBe(0);
          expect(b.handled, label).toBe(1);
        } else {
          expect(a.handled, label).toBe(1);
        }
        expect({ ...a, handled: 0 }, label).toEqual({ ...b, handled: 0 });
        if (method === 'PATCH' && a.status < 400) {
          const who = (JSON.parse(a.body) as { owner: { actor: { id: string } } }).owner.actor.id;
          expect(a.audits, label).toEqual([`api.write PATCH ${AGENT} ${who}`]);
          areaWriteAudits += 1;
        }
      }
    }
    // Every kind of answer was met: refusals (401, 403) and owners.
    expect(refused).toBeGreaterThan(5);
    // The area write let in (the owner and the Admin user with the area, by
    // cookie and device token) wrote its one audit row on both apps.
    expect(areaWriteAudits).toBeGreaterThanOrEqual(3);
  });

  it('a content write: the item check, the create home and the audit row as the guard gave', async () => {
    const ID = '11111111-1111-4111-8111-111111111111';
    const may = (edit: boolean, manage = edit) => [{ edit, manage, copy: false }];
    // What the item-write check finds, each case: the statements' answers
    // in order. No row: not in the login's scope; then whether it exists.
    const items: Record<string, unknown[][]> = {
      'may-edit': [may(true)],
      'may-not': [may(false)],
      'read-only-copy': [[{ edit: true, manage: true, copy: true }]],
      'not-in-scope': [[], [{ one: 1 }]],
      'no-such-item': [[], []],
    };
    const homes: Record<string, Record<string, unknown>> = {
      lands: { createWs: '66666666-6666-4666-8666-666666666666', privateWs: null },
      'refused-workspace': { refused: 'workspace', message: 'You are not in that workspace.' },
      'refused-invalid': { refused: 'invalid', message: 'ws is not a workspace id.' },
    };
    const paths = [
      ['PATCH', `/api/notes/${ID}`],
      ['DELETE', `/api/notes/${ID}`],
      ['POST', `/api/formulas/${ID}/evaluate`],
      // The id the handler gets is the decoded segment: an encoded item id
      // is checked as that id; one that decodes to no item id, or not at
      // all, is the not-found answer (the security fix), for every login.
      ['PATCH', `/api/notes/${encodeURIComponent(ID).replace(/1/g, '%31')}`],
      ['PATCH', '/api/notes/not-an-item'],
      ['PATCH', '/api/notes/%E0%A4%A'],
    ] as const;
    const seenAnswers = new Set<string>();
    const run = async (label: string, method: string, path: string, setup: () => void) => {
      for (const cred of creds) {
        const answers = [];
        for (const app of [pipeline, guarded]) {
          setup();
          answers.push(await drive(app, method, path, cred.headers()));
        }
        const [a, b] = answers;
        const cell = `${label} ${method} ${path} ${cred.name}`;
        if (a!.status >= 400) {
          expect(a!.handled, cell).toBe(0);
          expect(b!.handled, cell).toBe(1);
        }
        expect({ ...a, handled: 0 }, cell).toEqual({ ...b, handled: 0 });
        seenAnswers.add(`${a!.status} ${a!.status >= 400 ? a!.body : ''}`);
      }
    };
    try {
      for (const [item, exec] of Object.entries(items)) {
        for (const [method, path] of paths) {
          await run(item, method, path, () => {
            counts.exec = exec.map((r) => [...r]);
          });
        }
      }
      for (const [home, answer] of Object.entries(homes)) {
        await run(home, 'POST', '/api/notes?ws=66666666-6666-4666-8666-666666666666', () => {
          counts.home = answer;
        });
      }
    } finally {
      counts.exec = [];
      counts.home = { createWs: null, privateWs: null };
    }
    const met = [...seenAnswers].join('\n');
    // Every answer of the write path was met, the same through both.
    expect(met).toContain('You cannot change this item in your workspaces.');
    expect(met).toContain('This item is in a workspace you are not in. Add yourself to it first.');
    expect(met).toContain('read-only copy');
    expect(met).toMatch(/^404 \{"ok":false,"error":"not found"\}$/m);
    expect(met).toMatch(/^403 .*"reason":"workspace"/m);
    expect(met).toMatch(/^400 /m);
    expect(met).toMatch(/^200 $/m);
  });

  it('more writes (part 3 audit): keys, manage, shares, revisions, deleted apps, app data', async () => {
    const { KEY_TOKENS } = await import('../a4-guard-sweep.keys');
    const key = (token: string) => () => ({ authorization: `Bearer ${token}` });
    // An API key's write on the v1 alias of a create: a key with every
    // area, read-only, one without the notes area, a member's.
    const keyCreds = [
      { name: 'write-key', headers: key(KEY_TOKENS.write) },
      { name: 'read-key', headers: key(KEY_TOKENS.read) },
      { name: 'area-key', headers: key(KEY_TOKENS.writeArea) },
      { name: 'member-key', headers: key(KEY_TOKENS.member) },
    ];
    const ID = '11111111-1111-4111-8111-111111111111';
    const WS = '66666666-6666-4666-8666-666666666666';
    const may = (edit: boolean, manage = edit, copy = false) => [{ edit, manage, copy }];
    // What the item-write check finds for an item the id names itself:
    // the statements' answers in order.
    const node: Record<string, unknown[][]> = {
      'may-edit': [may(true)],
      'edit-not-manage': [may(true, false)],
      'may-not': [may(false)],
      'read-only-copy': [may(true, true, true)],
      'not-in-scope': [[], [{ one: 1 }]],
      'no-such-item': [[], []],
    };
    // Through a share (an app's link needs manage) or a Recall revision:
    // the lookup first, then the item's answers; a lookup that names no
    // item.
    const through = (first: unknown[]) =>
      Object.fromEntries(Object.entries(node).map(([k, v]) => [k, [first, ...v]]));
    const share = {
      ...through([{ id: ID, type: 'page' }]),
      ...Object.fromEntries(
        Object.entries(through([{ id: ID, type: 'app' }])).map(([k, v]) => [`app-${k}`, v]),
      ),
      'no-item': [[{ id: null, type: null }]],
    };
    const revision = { ...through([{ id: ID }]), 'no-item': [[{ id: null }]] };
    // A deleted app's last snapshot: no home stored, a home its Moderator
    // manages or not, deleted by someone other than the owner, none.
    const deleted: Record<string, unknown[][]> = {
      'no-home': [[{ home: null, held: false }]],
      'home-manage': [[{ home: WS, held: false }], [{ manage: true }]],
      'home-not-manage': [[{ home: WS, held: false }], [{ manage: false }]],
      held: [[{ home: WS, held: true }]],
      'no-snapshot': [[]],
    };
    const odd = (id: string) => [
      encodeURIComponent(id).replace(/1/g, '%31'),
      'not-an-item',
      '%E0%A4%A',
    ];
    const cells: Array<[string, string, string, Record<string, unknown[][]>]> = [];
    const each = (
      method: string,
      path: (id: string) => string,
      cases: Record<string, unknown[][]>,
    ) => {
      cells.push([method, path(ID), 'item', cases]);
      // The encoded id is checked as the id it decodes to; the others are
      // the not-found answer, for every login.
      for (const id of odd(ID)) cells.push([method, path(id), 'odd', cases]);
    };
    each('POST', (id) => `/api/pages/${id}/move`, node);
    each('DELETE', (id) => `/api/notes/${id}`, node);
    each('DELETE', (id) => `/api/shares/${id}`, share);
    each('POST', (id) => `/api/recall/revisions/${id}/restore`, revision);
    each('DELETE', (id) => `/api/apps/deleted/${id}`, deleted);
    each('POST', (id) => `/api/apps/${id}/db-broker`, node);
    const seenAnswers = new Set<string>();
    const compare = async (
      cell: string,
      method: string,
      path: string,
      cred: { name: string; headers: () => Record<string, string> },
      setup: () => void,
    ) => {
      const answers = [];
      for (const app of [pipeline, guarded]) {
        setup();
        answers.push(await drive(app, method, path, cred.headers()));
      }
      const [a, b] = answers;
      const label = `${cell} ${method} ${path} ${cred.name}`;
      // A refusal never reaches the pipeline's handler; the guard's handler
      // ran unless the key gate refused first (both alike then).
      if (a!.status >= 400) expect(a!.handled, label).toBe(0);
      expect({ ...a, handled: 0 }, label).toEqual({ ...b, handled: 0 });
      seenAnswers.add(`${a!.status} ${a!.status >= 400 ? a!.body : ''}`);
    };
    try {
      for (const [method, path, kind, cases] of cells) {
        for (const [name, exec] of Object.entries(kind === 'odd' ? { odd: [] } : cases)) {
          for (const cred of creds) {
            await compare(name, method, path, cred, () => {
              counts.exec = exec.map((r) => [...(r as unknown[])]);
            });
          }
        }
      }
      // The key's create, and a ?ws= the create-home intent lands or
      // refuses, by key and by cookie.
      const homes: Record<string, Record<string, unknown>> = {
        none: { createWs: null, privateWs: null },
        lands: { createWs: WS, privateWs: null },
        'refused-workspace': { refused: 'workspace', message: 'You are not in that workspace.' },
      };
      for (const [home, answer] of Object.entries(homes)) {
        for (const path of ['/api/v1/notes', `/api/v1/notes?ws=${WS}`]) {
          for (const cred of [...keyCreds, ...creds]) {
            await compare(home, 'POST', path, cred, () => {
              counts.home = answer;
            });
          }
        }
      }
    } finally {
      counts.exec = [];
      counts.home = { createWs: null, privateWs: null };
    }
    const met = [...seenAnswers].join('\n');
    // Every answer of these write paths was met, the same through both.
    expect(met).toContain('You cannot change this item in your workspaces.');
    expect(met).toContain('Add yourself to it first.');
    expect(met).toContain('read-only copy');
    expect(met).toContain('only the owner deletes it for good');
    expect(met).toMatch(/^404 \{"ok":false,"error":"not found"\}$/m);
    expect(met).toMatch(/^403 .*"reason":"workspace"/m);
    expect(met).toMatch(/^403 .*"member-login"/m);
    expect(met).toMatch(/^401 /m);
    expect(met).toMatch(/^200 $/m);
    // The key's write reached the handler, its audit row naming the key's
    // login, the create home the guard named.
    counts.home = { createWs: WS, privateWs: null };
    try {
      const a = await drive(pipeline, 'POST', `/api/v1/notes?ws=${WS}`, keyCreds[0]!.headers());
      expect(a.status).toBe(200);
      expect(JSON.parse(a.body)).toMatchObject({
        owner: { actor: { id: ADMIN } },
        home: counts.home,
      });
      expect(a.audits).toEqual([`api.write POST /api/v1/notes ${ADMIN}`]);
    } finally {
      counts.home = { createWs: null, privateWs: null };
    }
  });

  it('a create lands where the guard put it, and the audit row names the login', async () => {
    counts.home = { createWs: '66666666-6666-4666-8666-666666666666', privateWs: null };
    try {
      for (const cred of [creds[1]!, creds[3]!]) {
        const a = await drive(pipeline, 'POST', '/api/notes', cred.headers());
        expect(a.status).toBe(200);
        expect(JSON.parse(a.body).home).toEqual(counts.home);
        expect(a.audits).toHaveLength(1);
        expect(a.audits[0]).toMatch(/^api\.write POST \/api\/notes /);
      }
    } finally {
      counts.home = { createWs: null, privateWs: null };
    }
  });

  it('the pipeline names the actor, notes the self row and writes the audit row', async () => {
    const res = await drive(pipeline, 'PUT', '/api/profile', creds[1]!.headers());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      owner: { id: ANCHOR, actor: { id: ADMIN } },
      actor: 'system:http:login-self',
      out: JSON.stringify({ kind: 'system', why: 'login-self' }),
    });
    expect(res.audits).toEqual([`api.write PUT /api/profile ${ADMIN}`]);
  });

  it('a member on a self row is refused by the gate; the handler never runs', async () => {
    const res = await drive(pipeline, 'GET', '/api/profile', creds[3]!.headers());
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ reason: 'member-login' });
    expect(res.handled).toBe(0);
  });

  it('an error the owner answer throws keeps the CORS headers, as the guard did', async () => {
    process.env.MANTLE_API_CORS_ORIGINS = 'https://client.example';
    const busy = Object.assign(new Error('could not obtain lock'), { code: '55P03' });
    try {
      for (const error of [busy, new Error('database down')]) {
        counts.auditThrows = error;
        const headers = { ...creds[1]!.headers(), origin: 'https://client.example' };
        const answers = [];
        for (const app of [pipeline, guarded]) {
          const res = await app.request('/api/profile', { method: 'PUT', headers });
          answers.push({
            status: res.status,
            body: await res.text(),
            cors: [...res.headers.entries()].filter(([k]) => k.startsWith('access-control-')),
            vary: res.headers.get('vary'),
          });
        }
        const [a, b] = answers;
        expect(a, error.message).toEqual(b);
        expect(a!.status).toBe(error === busy ? 409 : 500);
        expect(a!.cors).toContainEqual(['access-control-allow-origin', 'https://client.example']);
      }
    } finally {
      counts.auditThrows = null;
      delete process.env.MANTLE_API_CORS_ORIGINS;
    }
  });

  it('a stale manifest names a handler the module lacks: 405 with CORS, as the guard gave', async () => {
    // The manifest says PUT reads the caller; the module (changed since)
    // exports no PUT. No handler runs, so no guard ran before either: the
    // loader's 405 stands, with its CORS headers, though the answer threw.
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const session = await import('../../lib/auth/session');
    const apps = [true, false].map((read) => {
      const app = new Hono();
      app.use('*', gate());
      registerRoutes(
        app,
        [
          {
            pattern: '/api/profile',
            methods: ['GET', 'PUT'],
            catchAll: null,
            catchAllOptional: false,
            ...(read ? { reads: ownerReads(['GET', 'PUT']) } : {}),
            load: async () => ({ GET: async () => Response.json(session.ownerCaller()) }),
          },
        ],
        read ? undefined : { standIn: true },
      );
      app.onError(() => Response.json({ error: 'internal error' }, { status: 500 }));
      return app;
    });
    process.env.MANTLE_API_CORS_ORIGINS = 'https://client.example';
    counts.auditThrows = new Error('database down');
    try {
      const headers = { ...creds[1]!.headers(), origin: 'https://client.example' };
      const answers = [];
      for (const app of apps) {
        const res = await app.request('/api/profile', { method: 'PUT', headers });
        answers.push({
          status: res.status,
          body: await res.text(),
          cors: [...res.headers.entries()].filter(([k]) => k.startsWith('access-control-')),
        });
      }
      const [a, b] = answers;
      expect(a).toEqual(b);
      expect(a!.status).toBe(405);
      expect(a!.cors).toContainEqual(['access-control-allow-origin', 'https://client.example']);
    } finally {
      counts.auditThrows = null;
      delete process.env.MANTLE_API_CORS_ORIGINS;
    }
  });

  it('a catch-all whose bare prefix is the loader 404: the 404 with CORS stands, as the guard gave', async () => {
    // A catch-all row cannot carry the caller (buildRoutePolicy refuses
    // it); here one does, by a hand-built policy, to pin the loader: the
    // owner answer threw at the gate, but on the bare prefix no handler
    // runs, so no guard ran before either. The loader's 404 stands, with
    // the gate's CORS headers, the same as with the guard.
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const { buildRoutePolicy } = await import('../../lib/auth/route-policy');
    const session = await import('../../lib/auth/session');
    const pattern = '/api/profile/*';
    const base = buildRoutePolicy([
      { pattern: '/api/profile', methods: ['PUT'], reads: ownerReads(['PUT']) },
    ]);
    const apps = [true, false].map((read) => {
      const row = base.get('PUT /api/profile')!;
      const policy = new Map([
        [
          `PUT ${pattern}`,
          { ...row, key: `PUT ${pattern}`, pattern, caller: read ? row.caller : null },
        ],
      ]);
      expect(policy.get(`PUT ${pattern}`)!.caller).toBe(read ? 'owner' : null);
      const app = new Hono();
      app.use('*', gate());
      registerRoutes(
        app,
        [
          {
            pattern,
            methods: ['PUT'],
            catchAll: 'rest',
            catchAllOptional: false,
            ...(read ? { reads: ownerReads(['PUT']) } : {}),
            load: async () => ({
              PUT: async () => {
                counts.handled++;
                if (read) return Response.json(session.ownerCaller());
                const owner = await ownerGuard();
                return owner instanceof Response ? owner : Response.json(owner);
              },
            }),
          },
        ],
        policy,
      );
      app.onError(() => Response.json({ error: 'internal error' }, { status: 500 }));
      return app;
    });
    process.env.MANTLE_API_CORS_ORIGINS = 'https://client.example';
    counts.auditThrows = new Error('database down');
    const handled = counts.handled;
    try {
      const headers = { ...creds[1]!.headers(), origin: 'https://client.example' };
      const answers = [];
      for (const app of apps) {
        const res = await app.request('/api/profile', { method: 'PUT', headers });
        answers.push({
          status: res.status,
          body: await res.text(),
          cors: [...res.headers.entries()].filter(([k]) => k.startsWith('access-control-')),
        });
      }
      const [a, b] = answers;
      expect(a).toEqual(b);
      expect(a!.status).toBe(404);
      expect(a!.cors).toContainEqual(['access-control-allow-origin', 'https://client.example']);
      expect(counts.handled).toBe(handled);
      // Below the prefix the handler runs: the pipeline throws the answer
      // in its place, where the guard threw it (500 with CORS, both).
      const below = [];
      for (const app of apps) {
        const res = await app.request('/api/profile/x', { method: 'PUT', headers });
        below.push({
          status: res.status,
          cors: [...res.headers.entries()].filter(([k]) => k.startsWith('access-control-')),
        });
      }
      expect(below[0]).toEqual(below[1]);
      expect(below[0]!.status).toBe(500);
      expect(below[0]!.cors).toContainEqual([
        'access-control-allow-origin',
        'https://client.example',
      ]);
    } finally {
      counts.auditThrows = null;
      delete process.env.MANTLE_API_CORS_ORIGINS;
    }
  });

  it('ownerCallerWithSource and ownerCallerWithLogin read what their guards answer', async () => {
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const session = await import('../../lib/auth/session');
    const onError = () => Response.json({ error: 'internal error' }, { status: 500 });
    const pairs: Array<[name: string, read: () => unknown, guard: () => Promise<unknown>]> = [
      [
        'WithSource',
        session.ownerCallerWithSource,
        // What getOwnerOr401WithSource answered before it went (A4 exit).
        async () => {
          const got = await session.getOwnerOr401WithLogin();
          return got instanceof Response ? got : { user: got.user, source: got.source };
        },
      ],
      ['WithLogin', session.ownerCallerWithLogin, session.getOwnerOr401WithLogin],
    ];
    for (const [name, read, guard] of pairs) {
      const build = (reads: boolean) => {
        const handle = async () => {
          counts.handled += 1;
          if (reads) return Response.json(seen(read()));
          const got = await guard();
          return got instanceof Response ? got : Response.json(seen(got));
        };
        const app = new Hono();
        app.use('*', gate());
        registerRoutes(
          app,
          [
            { pattern: '/api/profile', methods: ['GET', 'PUT'] },
            { pattern: '/api/notes', methods: ['GET'] },
          ].map((e) => ({
            ...e,
            catchAll: null,
            catchAllOptional: false,
            ...(reads ? { reads: ownerReads(e.methods) } : {}),
            load: async () => Object.fromEntries(e.methods.map((m) => [m, handle])),
          })),
          reads ? undefined : { standIn: true },
        );
        app.onError(onError);
        return app;
      };
      const [a, b] = [build(true), build(false)];
      for (const [method, path] of [
        ['GET', '/api/profile'],
        ['PUT', '/api/profile'],
        ['GET', '/api/notes'],
      ] as const) {
        for (const cred of creds) {
          const x = await drive(a, method, path, cred.headers());
          const y = await drive(b, method, path, cred.headers());
          expect({ ...x, handled: 0 }, `${name} ${method} ${path} ${cred.name}`).toEqual({
            ...y,
            handled: 0,
          });
        }
      }
    }
    // Outside a routed request they throw, as ownerCaller() does.
    expect(() => session.ownerCallerWithSource()).toThrow(/answered no owner/);
    expect(() => session.ownerCallerWithLogin()).toThrow(/answered no owner/);
  });

  it('the member, any-login and chat rows answer every credential as their guards do (part 5)', async () => {
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const session = await import('../../lib/auth/session');
    const { KEY_TOKENS } = await import('../a4-guard-sweep.keys');
    // Each kind: its reader, and the guard it replaced.
    const kinds = {
      member: [session.memberCaller, session.getMemberOr401],
      // The any-login guard as its rows ask it: with the audit row (A4 hand
      // batch A, the answer step's).
      login: [session.loginCaller, () => session.getLoginOr401({ audit: true })],
      chat: [session.chatLoginCaller, session.getChatLoginOr401],
    } as const;
    // Real manifest patterns of each list, so registerRoutes builds their
    // real rows: a member read about the login's own things (self) and one
    // that reads team items (content), a member write; an any-login read
    // and write; a chat read and write, and a Telegram chat read and write.
    const rows: Array<{ pattern: string; methods: string[]; kind: keyof typeof kinds }> = [
      { pattern: '/api/member/mcp', methods: ['GET'], kind: 'member' },
      { pattern: '/api/member/home', methods: ['GET'], kind: 'member' },
      { pattern: '/api/member/push/subscriptions', methods: ['GET', 'POST'], kind: 'member' },
      { pattern: '/api/member/mcp/clients/:id', methods: ['DELETE'], kind: 'member' },
      { pattern: '/api/shell', methods: ['GET'], kind: 'login' },
      { pattern: '/api/access-keys', methods: ['GET', 'POST'], kind: 'login' },
      { pattern: '/api/assistant/thread', methods: ['GET'], kind: 'chat' },
      { pattern: '/api/assistant/read', methods: ['POST'], kind: 'chat' },
      { pattern: '/api/telegram/my-chats', methods: ['GET'], kind: 'chat' },
      { pattern: '/api/telegram/pair', methods: ['POST'], kind: 'chat' },
    ];
    const onError = () => Response.json({ error: 'internal error' }, { status: 500 });
    const build = (reads: boolean) => {
      const app = new Hono();
      app.use('*', gate());
      registerRoutes(
        app,
        rows.map(({ kind, ...e }) => {
          const [read, guard] = kinds[kind];
          const handle = async () => {
            counts.handled += 1;
            if (reads) return Response.json(seen(read()));
            const got = await guard();
            return got instanceof Response ? got : Response.json(seen(got));
          };
          return {
            ...e,
            catchAll: null,
            catchAllOptional: false,
            ...(reads ? { reads: Object.fromEntries(e.methods.map((m) => [m, kind])) } : {}),
            load: async () => Object.fromEntries(e.methods.map((m) => [m, handle])),
          };
        }),
        reads ? undefined : { standIn: true },
      );
      app.onError(onError);
      return app;
    };
    const [pipelineApp, guardedApp] = [build(true), build(false)];
    const key = (token: string) => () => ({ authorization: `Bearer ${token}` });
    const all = [
      ...creds,
      { name: 'none', headers: () => ({}) },
      { name: 'write-key', headers: key(KEY_TOKENS.write) },
      { name: 'member-key', headers: key(KEY_TOKENS.member) },
    ];
    const ID = '11111111-1111-4111-8111-111111111111';
    const met = new Set<string>();
    let writesLetIn = 0;
    for (const row of rows) {
      const path = row.pattern.replace(':id', ID);
      const methods = row.methods.includes('GET') ? [...row.methods, 'HEAD'] : row.methods;
      for (const method of methods) {
        for (const cred of all) {
          const a = await drive(pipelineApp, method, path, cred.headers());
          const b = await drive(guardedApp, method, path, cred.headers());
          const label = `${row.kind} ${method} ${row.pattern} ${cred.name}`;
          // A refusal is the gate's: the pipeline's handler never runs.
          if (a.status >= 400) expect(a.handled, label).toBe(0);
          else expect(a.handled, label).toBe(1);
          // The status, headers and body (the login, the actor, the scope
          // entered or the rule noted), the audit rows, the stamp.
          expect({ ...a, handled: 0 }, label).toEqual({ ...b, handled: 0 });
          met.add(`${row.kind} ${a.status}`);
          if (a.status === 200 && method !== 'GET' && method !== 'HEAD') {
            writesLetIn += 1;
            // An Admin user's chat write is on the audit trail, once.
            if (row.kind === 'chat' && cred.name.startsWith('admin')) {
              expect(a.audits, label).toEqual([`api.write ${method} ${path} ${ADMIN}`]);
            }
          }
        }
      }
    }
    // Each kind let a login through, and refused: a member route refuses
    // an Admin user (403 admin-login), every kind refuses no login (401).
    for (const answer of ['member 200', 'member 403', 'member 401', 'login 200', 'login 401']) {
      expect(met, answer).toContain(answer);
    }
    expect(met).toContain('chat 200');
    expect(met).toContain('chat 401');
    expect(writesLetIn).toBeGreaterThan(10);
    // A device token is stamped once on each kind's row.
    for (const [path, cred] of [
      ['/api/member/mcp', creds[6]!],
      ['/api/shell', creds[5]!],
      ['/api/assistant/thread', creds[6]!],
    ] as const) {
      const res = await drive(pipelineApp, 'GET', path, cred.headers());
      expect(res.status, path).toBe(200);
      expect(res.touches, path).toBe(1);
    }
    // An error the chat answer throws (the audit row of an Admin user's
    // write) is answered in the handler's place with the CORS headers, as
    // the guard's was.
    process.env.MANTLE_API_CORS_ORIGINS = 'https://client.example';
    counts.auditThrows = new Error('database down');
    try {
      const headers = { ...creds[1]!.headers(), origin: 'https://client.example' };
      const answers = [];
      for (const app of [pipelineApp, guardedApp]) {
        const res = await app.request('/api/assistant/read', { method: 'POST', headers });
        answers.push({
          status: res.status,
          body: await res.text(),
          cors: [...res.headers.entries()].filter(([k]) => k.startsWith('access-control-')),
        });
      }
      expect(answers[0]).toEqual(answers[1]);
      expect(answers[0]!.status).toBe(500);
      expect(answers[0]!.cors).toContainEqual([
        'access-control-allow-origin',
        'https://client.example',
      ]);
    } finally {
      counts.auditThrows = null;
      delete process.env.MANTLE_API_CORS_ORIGINS;
    }
    // Each reader throws where the pipeline gave no answer of its kind.
    expect(() => session.memberCaller()).toThrow(/answered no member/);
    expect(() => session.loginCaller()).toThrow(/answered no login/);
    expect(() => session.chatLoginCaller()).toThrow(/answered no chat login/);
  });

  it('a workspace and a grants write: the any-login audit row as workspaceCaller() wrote it (part 5 fix round 1)', async () => {
    // Real rows of the any-login list served twice: through the reader, and
    // through the guard path these rows ran before A4 hand batch A
    // (workspaceCaller() behind wsRoute and grantsRoute: getLoginOr401 and
    // the api.write row, written by hand after it until the hand batch, then
    // asked of the guard), which /api/shell and the self-logged
    // /api/access-keys cannot show. The 'login' answer step writes that row
    // now, and these cells hold it to the one row. workspaceCaller() is the
    // projection both paths answer with.
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const session = await import('../../lib/auth/session');
    const { workspaceCaller } = await import('../../lib/workspaces');
    const { KEY_TOKENS } = await import('../a4-guard-sweep.keys');
    const rows = [
      { pattern: '/api/workspaces', methods: ['POST'] },
      { pattern: '/api/grants/move', methods: ['POST'] },
    ];
    const build = (reads: boolean) => {
      const app = new Hono();
      app.use('*', gate());
      const handle = async () => {
        counts.handled += 1;
        if (reads) return Response.json(seen(workspaceCaller(session.loginCaller())));
        const login = await session.getLoginOr401({ audit: true });
        return login instanceof Response ? login : Response.json(seen(workspaceCaller(login)));
      };
      registerRoutes(
        app,
        rows.map((e) => ({
          ...e,
          catchAll: null,
          catchAllOptional: false,
          ...(reads
            ? { reads: Object.fromEntries(e.methods.map((m) => [m, 'login' as const])) }
            : {}),
          load: async () => Object.fromEntries(e.methods.map((m) => [m, handle])),
        })),
        reads ? undefined : { standIn: true },
      );
      app.onError(() => Response.json({ error: 'internal error' }, { status: 500 }));
      return app;
    };
    const [pipelineApp, guardedApp] = [build(true), build(false)];
    const key = (token: string) => () => ({ authorization: `Bearer ${token}` });
    const all = [
      ...creds,
      { name: 'none', headers: () => ({}) },
      { name: 'write-key', headers: key(KEY_TOKENS.write) },
      { name: 'member-key', headers: key(KEY_TOKENS.member) },
    ];
    const audited = new Set<string>();
    const members = new Set<string>();
    for (const row of rows) {
      for (const cred of all) {
        const a = await drive(pipelineApp, 'POST', row.pattern, cred.headers());
        const b = await drive(guardedApp, 'POST', row.pattern, cred.headers());
        const label = `POST ${row.pattern} ${cred.name}`;
        if (a.status >= 400) expect(a.handled, label).toBe(0);
        else expect(a.handled, label).toBe(1);
        // The answer, the audit rows and the stamp, as the guard path's.
        expect({ ...a, handled: 0 }, label).toEqual({ ...b, handled: 0 });
        if (a.status !== 200) continue;
        // An Admin user's write writes one api.write row; a member's own
        // session none (no key reaches these rows: the gate refuses it).
        const actor = { owner: ANCHOR, admin: ADMIN, limited: LIMITED }[
          cred.name.split('-')[0] as 'owner' | 'admin' | 'limited'
        ];
        expect(a.audits, label).toEqual(
          cred.name.startsWith('member') ? [] : [`api.write POST ${row.pattern} ${actor}`],
        );
        if (a.audits.length) audited.add(cred.name);
        else members.add(cred.name);
      }
    }
    expect([...audited].sort()).toEqual([
      'admin-bearer',
      'admin-cookie',
      'limited-bearer',
      'limited-cookie',
      'owner-cookie',
    ]);
    expect([...members].sort()).toEqual(['member-bearer', 'member-cookie']);
  });

  it('the switched rows answer every credential as their flag-first handlers did (hand batch A)', async () => {
    // The turn stream and cancel (MANTLE_TURN_STREAMING) and the dev tool
    // (never in production) checked their switch before their guard. The
    // gate answers the switch now, before the caller (the switch each
    // route file declares, read from the generated manifest here, so the
    // rows are served as the app serves them), and
    // the handlers read ownerCaller() first. Proof per credential: with the
    // switch on, the reader and the guard answer alike; with it off, every
    // credential the gate let reach the handler (the marker app, a handler
    // that reads nothing) gets the handler's off answer, and the others the
    // gate's refusal, as before.
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const session = await import('../../lib/auth/session');
    const { KEY_TOKENS } = await import('../a4-guard-sweep.keys');
    const { routeManifest } = await import('../route-manifest.gen');
    const rows = [
      '/api/assistant/turn/:turnId/cancel',
      '/api/assistant/turn/:turnId/stream',
      '/api/dev-tools/queue-approval',
    ].map((pattern) => {
      const e = routeManifest.find((x) => x.pattern === pattern)!;
      expect(e.switches, pattern).toBeDefined();
      return { pattern, methods: [...e.methods], switches: e.switches };
    });
    const MARK = 299;
    const build = (kind: 'reads' | 'guard' | 'mark') => {
      const app = new Hono();
      app.use('*', gate());
      const handle = async () => {
        counts.handled += 1;
        if (kind === 'mark') return new Response(null, { status: MARK });
        if (kind === 'reads') return Response.json(seen(session.ownerCaller()));
        const owner = await ownerGuard();
        return owner instanceof Response ? owner : Response.json(seen(owner));
      };
      registerRoutes(
        app,
        rows.map((e) => ({
          ...e,
          catchAll: null,
          catchAllOptional: false,
          ...(kind === 'reads' ? { reads: ownerReads(e.methods) } : {}),
          load: async () => Object.fromEntries(e.methods.map((m) => [m, handle])),
        })),
        kind === 'reads' ? undefined : { standIn: true },
      );
      app.onError(() => Response.json({ error: 'internal error' }, { status: 500 }));
      return app;
    };
    const [readsApp, guardApp, markApp] = [build('reads'), build('guard'), build('mark')];
    const key = (token: string) => () => ({ authorization: `Bearer ${token}` });
    const all = [
      ...creds,
      { name: 'none', headers: () => ({}) },
      { name: 'write-key', headers: key(KEY_TOKENS.write) },
      { name: 'member-key', headers: key(KEY_TOKENS.member) },
    ];
    const ID = '11111111-1111-4111-8111-111111111111';
    const cells: Array<[string, string, string, string]> = [
      ['POST', `/api/assistant/turn/${ID}/cancel`, 'MANTLE_TURN_STREAMING', '0'],
      ['GET', `/api/assistant/turn/${ID}/stream`, 'MANTLE_TURN_STREAMING', '0'],
      ['HEAD', `/api/assistant/turn/${ID}/stream`, 'MANTLE_TURN_STREAMING', '0'],
      ['POST', '/api/dev-tools/queue-approval', 'NODE_ENV', 'production'],
    ];
    const offAnswered = new Set<string>();
    for (const [method, path, name, off] of cells) {
      const before = process.env[name];
      for (const cred of all) {
        const label = `${method} ${path} ${cred.name}`;
        // The switch on: the reader answers as the guard did.
        const a = await drive(readsApp, method, path, cred.headers());
        const b = await drive(guardApp, method, path, cred.headers());
        expect({ ...a, handled: 0 }, label).toEqual({ ...b, handled: 0 });
        const reached = await drive(markApp, method, path, cred.headers());
        process.env[name] = off;
        try {
          const now = await drive(readsApp, method, path, cred.headers());
          expect(now.handled, label).toBe(0);
          if (reached.status === MARK) {
            // The handler's off answer, as its first statement gave it
            // (NextResponse.json, the handler's words), compared whole:
            // status, type, cache header and body, nothing touched, no
            // audit row, no handler run.
            const error = name === 'NODE_ENV' ? 'not available in production' : 'not found';
            const was = NextResponse.json({ error }, { status: 404 });
            expect(now, label).toEqual({
              status: was.status,
              type: was.headers.get('content-type'),
              cache: was.headers.get('cache-control'),
              body: method === 'HEAD' ? '' : await was.text(),
              touches: 0,
              audits: [],
              handled: 0,
            });
            offAnswered.add(cred.name);
          } else {
            // Refused by the gate before any handler, switch or not.
            expect({ ...now, handled: 0 }, label).toEqual({ ...reached, handled: 0 });
          }
        } finally {
          if (before === undefined) delete process.env[name];
          else process.env[name] = before;
        }
      }
    }
    // A member, a revoked token and an Admin user without the settings
    // area (the dev tool is a settings row) got the off answer, not their
    // guard's refusal.
    for (const name of ['member-cookie', 'revoked-bearer', 'limited-cookie', 'owner-cookie']) {
      expect(offAnswered, name).toContain(name);
    }
  });

  it('a device token is stamped once, by the pipeline', async () => {
    const res = await drive(pipeline, 'GET', '/api/profile', creds[5]!.headers());
    expect(res.status).toBe(200);
    expect(res.touches).toBe(1);
    // On an area row too, where the gate applies the login before its Admin
    // step and the pipeline's answer takes it as applied; and once on the
    // refusal of an Admin user without the area, as the guard stamped it.
    const area = await drive(pipeline, 'GET', '/api/users', creds[5]!.headers());
    expect(area.status).toBe(200);
    expect(area.touches).toBe(1);
    const refused = await drive(pipeline, 'GET', '/api/users', creds[8]!.headers());
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ reason: 'area', area: 'users' });
    expect(refused.touches).toBe(1);
    expect(refused.handled).toBe(0);
  });

  it('an area row: the gate carries the Admin view, step 5 refuses without the area (part 4)', async () => {
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const session = await import('../../lib/auth/session');
    const { currentCaller } = await import('@mantle/db');
    const app = new Hono();
    app.use('*', gate());
    registerRoutes(app, [
      {
        pattern: '/api/users',
        methods: ['GET'],
        catchAll: null,
        catchAllOptional: false,
        reads: ownerReads(['GET']),
        load: async () => ({
          GET: async () => {
            session.ownerCaller();
            const admin = currentCaller()?.admin;
            return Response.json({
              admin: admin ? { holdsAdmin: admin.holdsAdmin, areas: [...admin.areas] } : admin,
              actor: actorSetting(currentActor()!),
            });
          },
        }),
      },
    ]);
    // An Admin user with the area: step 5 read the view and let it through.
    const ok = await app.request('/api/users', { headers: creds[1]!.headers() });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      admin: { holdsAdmin: true, areas: ['users'] },
      actor: 'system:http:admin-area',
    });
    // Without it: the gate's refusal, in the guard's words; the handler
    // never ran. A member and no login: the pipeline's answer, as before.
    const no = await app.request('/api/users', { headers: creds[2]!.headers() });
    expect(no.status).toBe(403);
    expect(await no.json()).toEqual({
      error: 'forbidden',
      reason: 'area',
      area: 'users',
      message: 'You cannot manage this part of the brain.',
    });
    const member = await app.request('/api/users', { headers: creds[3]!.headers() });
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ reason: 'member-login' });
    expect((await app.request('/api/users')).status).toBe(401);
  });

  it("an area row answers every credential with the guard's CORS headers (part 4)", async () => {
    process.env.MANTLE_API_CORS_ORIGINS = 'https://client.example';
    try {
      for (const method of ['GET', 'HEAD']) {
        for (const cred of [{ name: 'none', headers: () => ({}) }, ...creds]) {
          const answers = [];
          for (const app of [pipeline, guarded]) {
            const res = await app.request('/api/users', {
              method,
              headers: { ...cred.headers(), origin: 'https://client.example' },
            });
            answers.push({
              status: res.status,
              body: await res.text(),
              headers: [...res.headers.entries()].sort(),
            });
          }
          const [a, b] = answers;
          expect(a, `${method} ${cred.name}`).toEqual(b);
          expect(a!.headers, `${method} ${cred.name}`).toContainEqual([
            'access-control-allow-origin',
            'https://client.example',
          ]);
        }
      }
    } finally {
      delete process.env.MANTLE_API_CORS_ORIGINS;
    }
  });

  it('a stamp that fails before the Admin step is answered as the guard answered it, with CORS', async () => {
    process.env.MANTLE_API_CORS_ORIGINS = 'https://client.example';
    const busy = Object.assign(new Error('could not obtain lock'), { code: '55P03' });
    try {
      for (const error of [busy, new Error('database down')]) {
        for (const cred of [creds[5]!, creds[8]!]) {
          const answers = [];
          for (const app of [pipeline, guarded]) {
            counts.touchThrows = error;
            counts.handled = 0;
            const res = await app.request('/api/users', {
              headers: { ...cred.headers(), origin: 'https://client.example' },
            });
            answers.push({
              status: res.status,
              body: await res.text(),
              cors: [...res.headers.entries()].filter(([k]) => k.startsWith('access-control-')),
              vary: res.headers.get('vary'),
            });
          }
          const [a, b] = answers;
          expect(a, `${error.message} ${cred.name}`).toEqual(b);
          expect(a!.status).toBe(error === busy ? 409 : 500);
          expect(a!.cors).toContainEqual(['access-control-allow-origin', 'https://client.example']);
        }
      }
    } finally {
      counts.touchThrows = null;
      delete process.env.MANTLE_API_CORS_ORIGINS;
    }
  });

  it('enterRouteLogin with no logins bound fails as a RouteLoginError (answered with CORS)', async () => {
    const session = await import('../../lib/auth/session');
    let ran = false;
    const failed = await session
      .enterRouteLogin(async () => {
        ran = true;
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(failed).toBeInstanceOf(session.RouteLoginError);
    expect(String((failed as InstanceType<typeof session.RouteLoginError>).error)).toMatch(
      /no logins bound/,
    );
    expect(ran).toBe(false);
  });

  it('the byte routes and the frame documents answer every credential as their guards did (hand batch B)', async () => {
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const session = await import('../../lib/auth/session');
    const tokens = await import('../../lib/auth/tokens');
    const { RENDER_COOKIE_NAME } = await import('../../lib/auth-constants');
    const { KEY_TOKENS } = await import('../a4-guard-sweep.keys');
    const ID = '11111111-1111-4111-8111-111111111111';
    const { assetQueryAsHanded } = await import('../../lib/auth/route-policy');
    /** The request a route file hands its handler: the v1 download sends
     *  the bytes handler `?raw=1` and nothing else (its route file reads it
     *  from the same constant: download-query.test.ts). */
    const handed = (req: Request, pattern: string) => {
      const query = assetQueryAsHanded({ method: 'GET', pattern });
      if (query === null) return req;
      const url = new URL(req.url);
      url.search = query;
      return new Request(url, { method: 'GET', headers: req.headers });
    };
    type Row = {
      pattern: string;
      caller: RouteCaller;
      gone?: boolean;
      read: () => unknown;
      guard: (req: Request) => Promise<unknown>;
    };
    const rows: Row[] = [
      {
        pattern: '/api/attachments/:id',
        caller: 'ownerAsset',
        read: () => session.ownerAssetCaller(),
        guard: (req) => session.getOwnerForAsset(req),
      },
      {
        pattern: '/api/profile/photo',
        caller: 'ownerAsset',
        read: () => session.ownerAssetCaller(),
        guard: (req) => session.getOwnerForAsset(req),
      },
      {
        pattern: '/api/draws/:id/svg',
        caller: 'readerAsset',
        read: () => session.readerAssetCaller(),
        guard: (req) => session.getReaderForAsset(req),
      },
      {
        pattern: '/api/files/files/:id',
        caller: 'readerAsset',
        read: () => session.readerAssetCaller(),
        guard: (req) => session.getReaderForAsset(req),
      },
      {
        pattern: '/api/v1/files/:id/download',
        caller: 'readerAsset',
        read: () => session.readerAssetCaller(),
        guard: (req) => session.getReaderForAsset(req),
      },
      {
        pattern: '/api/member/files/:id',
        caller: 'memberAsset',
        gone: true,
        read: () => session.memberAssetCaller(),
        guard: (req) => session.getMemberForAsset(req),
      },
      {
        // The frame ticket: no guard before; the handler verified it.
        pattern: '/api/apps/:id/frame',
        caller: 'frame',
        read: () => ({ ticket: session.frameTicketCaller() }),
        guard: async (req) => {
          const t = new URL(req.url).searchParams.get('t');
          return { ticket: t ? tokens.verifyAppFrameTicket(t) : null };
        },
      },
    ];
    const build = (reads: boolean) => {
      const app = new Hono();
      app.use('*', gate());
      registerRoutes(
        app,
        rows.map((r) => {
          const handle = async (req: Request) => {
            counts.handled += 1;
            if (reads) return Response.json(seen(r.read()));
            const got = await r.guard(handed(req, r.pattern));
            return got instanceof Response ? got : Response.json(seen(got));
          };
          return {
            pattern: r.pattern,
            methods: ['GET'],
            catchAll: null,
            catchAllOptional: false,
            ...(reads ? { reads: { GET: r.caller } } : {}),
            ...(reads && r.gone ? { gone: ['GET'] } : {}),
            load: async () => ({ GET: handle }),
          };
        }),
        reads ? undefined : { standIn: true },
      );
      app.onError(() => Response.json({ error: 'internal error' }, { status: 500 }));
      return app;
    };
    const [pipelineApp, guardedApp] = [build(true), build(false)];
    const key = (token: string) => () => ({ authorization: `Bearer ${token}` });
    const at = (actor: string) => `at=${encodeURIComponent(tokens.buildAssetToken(ANCHOR, actor))}`;
    const render = () => ({
      cookie: `${RENDER_COOKIE_NAME}=${tokens.buildRenderToken({ ownerId: ANCHOR, actorId: ADMIN, nodeId: ID })}`,
    });
    const frame = (o: Partial<Parameters<typeof tokens.buildAppFrameTicket>[0]>) =>
      `t=${encodeURIComponent(tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId: ID, ...o }))}`;
    // Every credential, alone and with a `?at=` token beside it (a session
    // wins; a member's session, a revoked device or no login fall back to
    // the token, where the route reads one), the render cookie, the frame
    // tickets.
    const all: Array<{ name: string; headers: () => Record<string, string>; query?: string }> = [
      ...creds,
      { name: 'none', headers: () => ({}) },
      { name: 'write-key', headers: key(KEY_TOKENS.write) },
      { name: 'member-key', headers: key(KEY_TOKENS.member) },
      { name: 'asset-admin', headers: () => ({}), query: at(ADMIN) },
      { name: 'asset-member', headers: () => ({}), query: at(MEMBER) },
      { name: 'member-cookie+asset-admin', headers: creds[3]!.headers, query: at(ADMIN) },
      { name: 'revoked+asset-admin', headers: creds[7]!.headers, query: at(ADMIN) },
      { name: 'admin-cookie+asset-member', headers: creds[1]!.headers, query: at(MEMBER) },
      { name: 'render', headers: render },
      { name: 'frame-admin', headers: () => ({}), query: frame({ actorId: ADMIN }) },
      { name: 'frame-member', headers: () => ({}), query: frame({ loginId: MEMBER }) },
      { name: 'frame-bogus', headers: () => ({}), query: 't=not-a-ticket' },
    ];
    const met = new Set<string>();
    for (const row of rows) {
      const base = row.pattern.replace(':id', ID);
      for (const method of ['GET', 'HEAD']) {
        for (const cred of all) {
          const path = cred.query ? `${base}?${cred.query}` : base;
          const a = await drive(pipelineApp, method, path, cred.headers());
          const b = await drive(guardedApp, method, path, cred.headers());
          const label = `${row.caller} ${method} ${row.pattern} ${cred.name}`;
          // An asset refusal is the gate's: the handler never runs. The
          // frame answer refuses nothing (no guard was there).
          if (a.status >= 400 && row.caller !== 'frame') expect(a.handled, label).toBe(0);
          expect({ ...a, handled: 0 }, label).toEqual({ ...b, handled: 0 });
          met.add(`${row.caller} ${a.status}`);
        }
      }
    }
    for (const answer of [
      'ownerAsset 200',
      'ownerAsset 401',
      'ownerAsset 403',
      'readerAsset 200',
      'readerAsset 401',
      'memberAsset 200',
      'memberAsset 401',
      'frame 200',
      'frame 401',
    ]) {
      expect(met, answer).toContain(answer);
    }
    // The v1 download never honoured a `?at=` (its route file hands the
    // bytes handler `?raw=1` alone): a member's session with an Admin
    // user's token is the member there, who reads the file as its base
    // route lets it (D3, the A8 finding F1: in its own scope, never as the
    // token's Admin user), and the Admin user on the bytes route itself,
    // through both paths alike (the cells above).
    const v1 = await drive(
      pipelineApp,
      'GET',
      `/api/v1/files/${ID}/download?${at(ADMIN)}`,
      creds[3]!.headers(),
    );
    expect(v1.status).toBe(200);
    expect((JSON.parse(v1.body) as { owner: { member: unknown } }).owner.member).not.toBeNull();
    const bytes = await drive(
      pipelineApp,
      'GET',
      `/api/files/files/${ID}?${at(ADMIN)}`,
      creds[3]!.headers(),
    );
    expect(bytes.status).toBe(200);
    expect((JSON.parse(bytes.body) as { owner: { member: unknown } }).owner.member).toBeNull();
    // A device token is stamped once on a byte route.
    const res = await drive(pipelineApp, 'GET', `/api/attachments/${ID}`, creds[5]!.headers());
    expect(res.status).toBe(200);
    expect(res.touches).toBe(1);
    // Each reader throws where the pipeline gave no answer of its kind.
    expect(() => session.ownerAssetCaller()).toThrow(/answered no asset owner/);
    expect(() => session.readerAssetCaller()).toThrow(/answered no asset reader/);
    expect(() => session.memberAssetCaller()).toThrow(/answered no asset member/);
    expect(() => session.frameTicketCaller()).toThrow(/answered no frame ticket/);
  });

  it('the answers taken at the read: what the handler does first stays first (hand batch B)', async () => {
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const { answerAppError } = await import('../app-error');
    const session = await import('../../lib/auth/session');
    const { KEY_TOKENS } = await import('../a4-guard-sweep.keys');
    const ID = '11111111-1111-4111-8111-111111111111';
    type Row = {
      pattern: string;
      method: string;
      caller: RouteCaller;
      read: () => Promise<unknown>;
      guard: () => Promise<unknown>;
    };
    const rows: Row[] = [
      {
        pattern: '/api/auth/whoami',
        method: 'GET',
        caller: 'publicLogin',
        read: () => session.publicLoginCaller(),
        guard: () => session.getLoginOr401(),
      },
      {
        pattern: '/api/auth/logout',
        method: 'POST',
        caller: 'publicLogin',
        read: () => session.publicLoginCaller(),
        guard: () => session.getLoginOr401(),
      },
      {
        // The generic api.write row, as the guard's `audit` wrote it.
        pattern: '/api/auth/pair',
        method: 'POST',
        caller: 'publicLogin',
        read: () => session.publicLoginCaller({ audit: true }),
        guard: () => session.getLoginOr401({ audit: true }),
      },
      {
        pattern: '/api/auth/sso',
        method: 'POST',
        caller: 'cookieUpgrade',
        read: () => session.cookieUpgradeCaller(),
        guard: () => session.getCookieUpgradeLoginOr401(),
      },
      {
        // The owner, its item check and its audit row, at the read; a
        // refusal thrown and answered by the app as the guard's was
        // returned.
        pattern: '/api/pages/:id',
        method: 'PATCH',
        caller: 'ownerAtRead',
        read: () => session.ownerCallerAtRead(),
        guard: async () => {
          const got = await session.getOwnerOr401WithLogin();
          return got instanceof Response ? got : got.user;
        },
      },
    ];
    const build = (reads: boolean) => {
      const app = new Hono();
      app.use('*', gate());
      registerRoutes(
        app,
        rows.map((r) => {
          const handle = async (req: Request) => {
            counts.handled += 1;
            // What the handler answers before it reads (a cross-site
            // refusal, a throttle, a key's rule): no lookup, no stamp, no
            // audit row, through both paths.
            if (req.headers.get('x-first') === 'refuse') {
              return Response.json({ error: 'first' }, { status: 403 });
            }
            if (reads) {
              const got = await r.read();
              return got === null ? session.unauthorizedRefusal() : Response.json(seen(got));
            }
            const got = await r.guard();
            return got instanceof Response ? got : Response.json(seen(got));
          };
          return {
            pattern: r.pattern,
            methods: [r.method],
            catchAll: null,
            catchAllOptional: false,
            ...(reads ? { reads: { [r.method]: r.caller } } : {}),
            load: async () => ({ [r.method]: handle }),
          };
        }),
        reads ? undefined : { standIn: true },
      );
      app.onError(answerAppError);
      return app;
    };
    const [pipelineApp, guardedApp] = [build(true), build(false)];
    const key = (token: string) => () => ({ authorization: `Bearer ${token}` });
    const all = [
      ...creds,
      { name: 'none', headers: () => ({}) },
      { name: 'write-key', headers: key(KEY_TOKENS.write) },
      { name: 'member-key', headers: key(KEY_TOKENS.member) },
    ];
    const may = [[{ edit: true, manage: true, copy: false }]];
    const met = new Set<string>();
    for (const row of rows) {
      const path = row.pattern.replace(':id', ID);
      const methods = row.method === 'GET' ? ['GET', 'HEAD'] : [row.method];
      for (const method of methods) {
        for (const first of [false, true]) {
          for (const cred of all) {
            const headers = { ...cred.headers(), ...(first ? { 'x-first': 'refuse' } : {}) };
            const answers = [];
            for (const app of [pipelineApp, guardedApp]) {
              counts.exec = may.map((r) => [...r]);
              answers.push(await drive(app, method, path, headers));
            }
            const [a, b] = answers;
            const label = `${row.caller} ${method} ${row.pattern} ${cred.name}${first ? ' first' : ''}`;
            // The handler runs as it did (the answer is taken at its read):
            // only the gate's own refusals (a key off /api/v1) come first.
            expect(a!.handled, label).toBe(b!.handled);
            expect({ ...a, handled: 0 }, label).toEqual({ ...b, handled: 0 });
            if (first && a!.handled === 1) {
              expect(a!.status, label).toBe(403);
              expect(a!.touches, label).toBe(0);
              expect(a!.audits, label).toEqual([]);
            }
            if (!first) met.add(`${row.caller} ${a!.status}`);
          }
        }
      }
    }
    counts.exec = [];
    for (const answer of [
      'publicLogin 200',
      'publicLogin 401',
      'cookieUpgrade 200',
      'cookieUpgrade 401',
      'ownerAtRead 200',
      'ownerAtRead 401',
    ]) {
      expect(met, answer).toContain(answer);
    }
    // The device token is stamped once, at the read.
    const res = await drive(pipelineApp, 'GET', '/api/auth/whoami', creds[5]!.headers());
    expect(res.status).toBe(200);
    expect(res.touches).toBe(1);
    // An Admin user's pair writes its one api.write row, at the read.
    const pair = await drive(pipelineApp, 'POST', '/api/auth/pair', creds[1]!.headers());
    expect(pair.audits).toEqual([`api.write POST /api/auth/pair ${ADMIN}`]);
    // Each reader throws where the pipeline gave no answer of its kind.
    await expect(session.publicLoginCaller()).rejects.toThrow(/answered no public login/);
    await expect(session.cookieUpgradeCaller()).rejects.toThrow(/answered no cookie upgrade/);
    await expect(session.ownerCallerAtRead()).rejects.toThrow(/answered no owner at the read/);
  });

  it('a public row reads only a public kind, and a public kind only a public row (hand batch B)', async () => {
    const { buildRoutePolicy } = await import('../../lib/auth/route-policy');
    const reads = (pattern: string, method: string, caller: RouteCaller, gone = false) =>
      buildRoutePolicy([
        {
          pattern,
          methods: [method],
          reads: { [method]: caller },
          ...(gone ? { gone: [method] } : {}),
        },
      ]).get(`${method} ${pattern}`)?.caller;
    expect(reads('/api/auth/whoami', 'GET', 'publicLogin')).toBe('publicLogin');
    expect(reads('/api/auth/sso', 'POST', 'cookieUpgrade')).toBe('cookieUpgrade');
    expect(reads('/api/attachments/:id', 'GET', 'ownerAsset')).toBe('ownerAsset');
    expect(reads('/api/files/files/:id', 'GET', 'readerAsset')).toBe('readerAsset');
    expect(reads('/api/member/files/:id', 'GET', 'memberAsset', true)).toBe('memberAsset');
    expect(reads('/api/apps/:id/frame', 'GET', 'frame')).toBe('frame');
    expect(reads('/api/pages/:id', 'PATCH', 'ownerAtRead')).toBe('ownerAtRead');
    for (const [pattern, method, caller] of [
      ['/api/profile', 'GET', 'publicLogin'],
      ['/api/shell', 'GET', 'publicLogin'],
      ['/api/auth/whoami', 'GET', 'owner'],
      ['/api/auth/whoami', 'GET', 'ownerAsset'],
      ['/api/auth/sso', 'POST', 'ownerAtRead'],
      ['/api/shell', 'GET', 'readerAsset'],
      ['/api/member/files/:id', 'GET', 'memberAsset'],
      ['/api/profile', 'GET', 'frame'],
      // The answer taken at the read comes after the gate's Admin step: no
      // area row reads it.
      ['/api/users', 'GET', 'ownerAtRead'],
    ] as const) {
      expect(() => reads(pattern, method, caller), `${method} ${pattern} ${caller}`).toThrow(
        new RegExp(`the ${caller} guard does not serve its row`),
      );
    }
  });

  it('the kinds of hand batch B are read only on the rows named for them (fix round 1, M2)', async () => {
    const { buildRoutePolicy, OWNER_AT_READ_ROWS, PUBLIC_LOGIN_ROWS } =
      await import('../../lib/auth/route-policy');
    const reads = (pattern: string, method: string, caller: RouteCaller, gone = false) =>
      buildRoutePolicy([
        {
          pattern,
          methods: [method],
          reads: { [method]: caller },
          ...(gone ? { gone: [method] } : {}),
        },
      ]);
    // Served: each named row, its HEAD with its GET, the v1 asset rows.
    expect(
      reads('/api/auth/whoami', 'GET', 'publicLogin').get('HEAD /api/auth/whoami')?.caller,
    ).toBe('publicLogin');
    expect(reads('/api/oauth/authorize', 'POST', 'publicLogin').size).toBe(1);
    expect(reads('/api/pages/:id', 'PATCH', 'ownerAtRead').size).toBe(1);
    expect(reads('/api/v1/pages/:id', 'PATCH', 'ownerAtRead').size).toBe(1);
    expect(reads('/api/v1/files/:id', 'GET', 'readerAsset').size).toBe(2);
    expect(reads('/api/v1/files/:id/download', 'GET', 'readerAsset').size).toBe(2);
    expect(reads('/api/export/:id', 'GET', 'ownerAsset').get('HEAD /api/export/:id')?.caller).toBe(
      'ownerAsset',
    );
    for (const [pattern, method, caller, gone] of [
      // The owner at the read: any other owner row, self or content.
      ['/api/profile', 'GET', 'ownerAtRead'],
      ['/api/profile', 'PUT', 'ownerAtRead'],
      ['/api/notes/:id', 'PATCH', 'ownerAtRead'],
      ['/api/pages/:id', 'DELETE', 'ownerAtRead'],
      ['/api/v1/pages/:id', 'GET', 'ownerAtRead'],
      // An asset kind: a write row of a byte route, a non-asset path, an
      // /api/v1 row that runs no byte handler.
      ['/api/files/files/:id', 'POST', 'readerAsset'],
      ['/api/files/files/:id', 'PATCH', 'ownerAsset'],
      ['/api/attachments/:id', 'DELETE', 'ownerAsset'],
      ['/api/profile/photo', 'POST', 'ownerAsset'],
      ['/api/profile', 'GET', 'ownerAsset'],
      ['/api/notes', 'GET', 'readerAsset'],
      ['/api/v1/pages', 'GET', 'readerAsset'],
      ['/api/v1/files/:id', 'DELETE', 'readerAsset'],
      ['/api/member/mcp', 'GET', 'memberAsset', true],
      ['/api/member/files/:id', 'POST', 'memberAsset', true],
      // A public login kind: a public row that reads no login (sign-in, the
      // /s link routes, the remote MCP, federation), or the other kind's row.
      ['/api/auth/login', 'POST', 'publicLogin'],
      ['/s/:token/view', 'GET', 'publicLogin'],
      ['/s/:token/frame-ticket', 'POST', 'cookieUpgrade'],
      ['/api/mcp', 'POST', 'publicLogin'],
      ['/api/mcp', 'GET', 'cookieUpgrade'],
      ['/api/federation/query', 'POST', 'publicLogin'],
      ['/api/oauth/token', 'POST', 'publicLogin'],
      ['/api/auth/whoami', 'GET', 'cookieUpgrade'],
      ['/api/auth/sso', 'POST', 'publicLogin'],
      ['/api/auth/pair/:id', 'DELETE', 'publicLogin'],
    ] as const) {
      expect(
        () => reads(pattern, method, caller, gone === true),
        `${method} ${pattern} ${caller}`,
      ).toThrow(new RegExp(`the ${caller} guard does not serve its row`));
    }
    // The app's rows of each kind are its named rows.
    const { routeManifest } = await import('../route-manifest.gen');
    const table = [...buildRoutePolicy(routeManifest).values()];
    const keysOf = (...kinds: RouteCaller[]) =>
      table
        .filter((r) => r.caller && kinds.includes(r.caller))
        .map((r) => r.key)
        .sort();
    const asHandled = (key: string) => key.replace(/^HEAD /, 'GET ');
    expect(new Set(keysOf('publicLogin', 'cookieUpgrade').map(asHandled))).toEqual(
      new Set(PUBLIC_LOGIN_ROWS.keys()),
    );
    expect(keysOf('ownerAtRead')).toEqual([...OWNER_AT_READ_ROWS].sort());
    for (const r of table.filter((r) => /Asset$/.test(r.caller ?? ''))) {
      expect(['GET', 'HEAD'], r.key).toContain(r.method);
    }
  });

  it('ownerCaller() where the pipeline answered no owner throws: fail closed', async () => {
    const session = await import('../../lib/auth/session');
    expect(() => session.ownerCaller()).toThrow(/answered no owner/);
    // A row whose handler reads it, but the manifest does not say so: the
    // gate does not answer, and the read fails rather than run unchecked.
    // (The app's rows refuse that at boot, buildRouteRow M1; a stand-in
    // row is let through to pin the read's own refusal.)
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const app = new Hono();
    app.use('*', gate());
    registerRoutes(
      app,
      [
        {
          pattern: '/api/profile',
          methods: ['GET'],
          catchAll: null,
          catchAllOptional: false,
          load: async () => ({ GET: async () => Response.json(session.ownerCaller()) }),
        },
      ],
      { standIn: true },
    );
    app.onError(() => new Response('failed', { status: 500 }));
    const res = await app.request('/api/profile', { headers: creds[1]!.headers() });
    expect(res.status).toBe(500);
  });

  it("a row a kind's guard does not serve cannot read that kind's caller", async () => {
    const { buildRoutePolicy } = await import('../../lib/auth/route-policy');
    // An any-login route (its own guard), a member route, a public route.
    for (const pattern of ['/api/shell', '/api/member/mcp', '/api/auth/whoami']) {
      expect(() =>
        buildRoutePolicy([{ pattern, methods: ['GET'], reads: ownerReads(['GET']) }]),
      ).toThrow(/the owner guard does not serve its row/);
    }
    // A catch-all route keeps its guard.
    expect(() =>
      buildRoutePolicy([
        { pattern: '/api/docs/:collection/*', methods: ['GET'], reads: ownerReads(['GET']) },
      ]),
    ).toThrow(/is a catch-all/);
    // Each other kind only on the rows of its own list (A4 step 3b part 5):
    // the member guard's, the any-login guard's, the chat guard's (the chat
    // and the Telegram chat lists).
    const reads = (pattern: string, method: string, caller: RouteCaller) =>
      buildRoutePolicy([{ pattern, methods: [method], reads: { [method]: caller } }]).get(
        `${method} ${pattern}`,
      )?.caller;
    expect(reads('/api/member/mcp', 'GET', 'member')).toBe('member');
    expect(reads('/api/shell', 'GET', 'login')).toBe('login');
    expect(reads('/api/assistant/thread', 'GET', 'chat')).toBe('chat');
    expect(reads('/api/telegram/pair', 'POST', 'chat')).toBe('chat');
    for (const [pattern, method, caller] of [
      ['/api/profile', 'GET', 'member'],
      ['/api/shell', 'GET', 'member'],
      ['/api/member/mcp', 'GET', 'chat'],
      ['/api/assistant/thread', 'GET', 'login'],
      ['/api/telegram/chats/:id', 'PATCH', 'chat'],
      ['/api/notes', 'GET', 'login'],
      ['/api/auth/whoami', 'GET', 'login'],
      ['/api/auth/pair', 'POST', 'login'],
    ] as const) {
      expect(() => reads(pattern, method, caller), `${method} ${pattern} ${caller}`).toThrow(
        new RegExp(`the ${caller} guard does not serve its row`),
      );
    }
    // A HEAD row reads what its GET reads.
    const rows = buildRoutePolicy([
      { pattern: '/api/profile', methods: ['GET'], reads: ownerReads(['GET']) },
    ]);
    expect(rows.get('GET /api/profile')?.caller).toBe('owner');
    expect(rows.get('HEAD /api/profile')?.caller).toBe('owner');
  });
});
