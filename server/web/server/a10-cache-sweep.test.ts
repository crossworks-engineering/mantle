/**
 * The cache sweep (A10 #15: the gate answers Cache-Control: no-store on /api
 * by default; docs/std-helpers.md, "Cache-Control"). Every route of the
 * manifest and every method, driven through the full pipeline (the gate,
 * the row, the caller's answer, the handler) as each credential its row
 * admits (nobody always; the owner on a login row; a member too where the
 * row admits members), a write with the body sweep's valid body
 * (__snapshots__/a10-body-sweep.bodies.json). Per cell: the status, the
 * content type and the Cache-Control header. Plus an unknown /api path and
 * a CORS preflight.
 *
 * The stand-ins are the body sweep's: no database (a query finds no row, a
 * statement finds one item the login may edit), no network, no child
 * process.
 *
 * Recorded on main (v0.300.63) BEFORE the move, in
 * __snapshots__/a10-cache-sweep.txt (A10_CACHE_SWEEP_RECORD=1 writes it; a
 * normal run only reads it). At the move every cell answered as recorded,
 * or the one named change: an /api answer that had no Cache-Control on main
 * answered `no-store` (the gate's default). Those cells are the record in
 * __snapshots__/a10-cache-sweep-changes.txt, kept as written at the move.
 *
 * Since (fix round 1, M1) the sweep holds a forward rule, so a route added
 * or changed later does not fail it for being new:
 *
 *  - every /api cell carries a Cache-Control header;
 *  - every cell outside /api answers as recorded (a surface outside /api
 *    has no default, so its answer is reviewed): from the record, or, for a
 *    cell added since, from OUTSIDE_API_SINCE below.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { warmWorkspacesMock } from '../lib/test-support/workspaces-mock';

const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const SPACE_ID = '66666666-6666-4666-8666-666666666666';

const loginRow = (id: string, role: string, isOwner = false) => ({
  id,
  email: `${role}-${id.slice(0, 4)}@example.invalid`,
  isOwner,
  displayName: `${role} ${id.slice(0, 4)}`,
  role,
  adminMember: role === 'admin',
  contactId: null,
  disabledAt: null,
  sessionEpoch: 0,
});

vi.mock('../lib/brain-identity', () => ({
  brainIdOrNull: async () => '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
  getBrainId: async () => '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
  brainIdField: async () => ({ brainId: '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f' }),
}));

vi.mock('../lib/auth/login-row', () => ({
  loadLoginRow: async (id: string) =>
    id === ANCHOR_ID
      ? loginRow(ANCHOR_ID, 'admin', true)
      : id === MEMBER_ID
        ? loginRow(MEMBER_ID, 'member')
        : null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => SPACE_ID,
  loadBearerToken: async () => null,
  touchBearerToken: async () => undefined,
}));

// The audit row a write makes (fire and forget): never written.
vi.mock('../lib/audit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditFireAndForget: () => undefined,
}));

vi.mock('../lib/mcp-auth', () => ({
  mcpLoginUsable: async () => false,
  mcpTargetLogin: async () => null,
}));

vi.mock('../lib/mcp-oauth', async (importOriginal) => {
  const { SWEEP_OAUTH_CLIENT } = await import('./public-session-routes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    isRemoteMcpEnabled: async () => true,
    getClient: async (id: string) =>
      id === SWEEP_OAUTH_CLIENT.id
        ? { id, clientName: 'Sweep client', redirectUris: [SWEEP_OAUTH_CLIENT.redirectUri] }
        : null,
  };
});

vi.mock('../lib/pair-code', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  issuePairCode: async () => ({
    id: '00000000-0000-4000-8000-0000000000c0',
    code: 'sweep-code-sweep-code-sweep',
    expiresAt: new Date('2026-10-01T00:01:30.000Z'),
  }),
  pairCodeStatus: async () => ({ status: 'pending', deviceLabel: null }),
}));

vi.mock('../lib/shares', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveActiveShareByToken: async () => null,
  resolveActiveShareRowByToken: async () => null,
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isRetiredTeamLinkToken: async () => false,
  isRetiredClientLinkToken: async () => false,
}));

// No child process is started from a sweep.
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const refuse = () => {
    throw new Error('sweep: no child process');
  };
  return { ...real, spawn: refuse, exec: refuse, execFile: refuse, fork: refuse };
});

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  // The guard sweep's READS (a4-guard-sweep.test.ts): a query (db.select and
  // its chain) finds no row; a statement (db.execute) finds one item the
  // login may edit and manage; withViewer runs its function. Anything else
  // is the real module's, which wants a database and throws.
  const none: unknown = new Proxy(() => undefined, {
    get: (_t, k) =>
      k === 'then'
        ? (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
            Promise.resolve([]).then(ok, ko)
        : () => none,
  });
  const db = new Proxy(real.db, {
    get: (t, k) => {
      if (k === 'select') return () => none;
      if (k === 'execute') {
        return async () => [
          {
            id: '11111111-1111-4111-8111-111111111111',
            type: 'page',
            edit: true,
            manage: true,
            copy: false,
            home: null,
            held: false,
          },
        ];
      }
      return Reflect.get(t, k);
    },
  });
  return {
    ...real,
    db,
    withViewer: ((_actsFor, fn) => fn()) as typeof real.withViewer,
    loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
    createHomeIntent: async () => ({ createWs: null, privateWs: null }),
  };
});
vi.mock('../lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workspaces')>()),
  requireArea: async () => true,
}));
// The mocked area module resolved alone, before any request (S9 part 3
// round 2: two first imports in flight at once can get the real module).
beforeAll(warmWorkspacesMock);
// The unpinned key picks (model picker fix round 1, L1) read through the
// keys package's own handle, not `db`; as a query here, they find no row,
// which is what the seeder's and the model combos' hand picks over `db`
// found on main.
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/api-keys')>()),
  findProviderKeyId: async () => null,
  findProviderKeyIds: async () => new Map<string, string>(),
}));

import { SESSION_COOKIE_NAME } from '../lib/auth-constants';
import { SAMPLE_ID } from './a10-body-sweep.samples';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));
if (!hasManifest && process.env.CI) {
  throw new Error('server/web/server/route-manifest.gen.ts is missing: the sweep cannot run');
}
const RECORD = process.env.A10_CACHE_SWEEP_RECORD === '1';
const BASELINE = join(here, '__snapshots__/a10-cache-sweep.txt');
const BODIES = join(here, '__snapshots__/a10-body-sweep.bodies.json');
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const NOW = new Date('2026-10-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
/** Each cell runs a day after the one before, so every rate limit it meets
 *  starts empty. */
const cellTime = (n: number) => new Date(NOW.getTime() + n * DAY);

function concretePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z0-9_]+\??/g, SAMPLE_ID).replace(/\*$/, 'a/b');
}

/** A cell outside /api added after the record, with the answer it was
 *  reviewed to give (`METHOD pattern cred` to `status type cache-control=`).
 *  None yet. */
const OUTSIDE_API_SINCE: Record<string, string> = {};

/** Whether a cell (`METHOD pattern cred`) is an /api one. */
function isApiCell(cell: string): boolean {
  const path = cell.split(' ')[1] ?? '';
  return path === '/api' || path.startsWith('/api/');
}

type Cell = { row: string; method: string; pattern: string; cred: string };

describe.skipIf(!hasManifest)('A10 #15: every /api answer carries Cache-Control', () => {
  const realFetch = globalThis.fetch;
  let app: import('hono').Hono;
  const cells: Cell[] = [];
  const creds: Record<string, Record<string, string>> = {};

  beforeAll(async () => {
    // vi.stubEnv records each value it replaces; afterAll's vi.unstubAllEnvs
    // puts every one back (or unsets it, if it was unset).
    vi.stubEnv('SESSION_SECRET', 'a10-cache-sweep-secret-that-is-at-least-32-chars');
    vi.stubEnv('DATABASE_URL', undefined);
    vi.stubEnv('MANTLE_API_CORS_ORIGINS', 'https://client.example.invalid');
    vi.stubEnv('MANTLE_DETACHED_DEV', undefined);
    globalThis.fetch = (async () => {
      throw new Error('sweep: no network');
    }) as typeof fetch;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const tokens = await import('../lib/auth/tokens');
    const cookie = (id: string) => ({
      cookie: `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(id, { ttlSeconds: 20 * 365 * 86_400 }).value}`,
    });
    creds.owner = cookie(ANCHOR_ID);
    creds.member = cookie(MEMBER_ID);
    creds.none = {};
    const { createApp } = await import('./app');
    app = await createApp();
    const { routeManifest } = await import('./route-manifest.gen');
    const { buildRoutePolicy } = await import('../lib/auth/route-policy');
    const policy = buildRoutePolicy(routeManifest);
    const entries = [...routeManifest].sort((a, b) =>
      a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0,
    );
    for (const e of entries) {
      for (const method of e.methods) {
        const row = policy.get(`${method} ${e.pattern}`);
        const who = !row
          ? ['none', 'owner']
          : row.public
            ? ['none']
            : row.logins && row.logins !== 'owner'
              ? ['none', 'owner', 'member']
              : ['none', 'owner'];
        for (const cred of who) {
          cells.push({ row: `${method} ${e.pattern}`, method, pattern: e.pattern, cred });
        }
      }
    }
  }, 120_000);

  afterAll(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  async function send(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<string> {
    const res = await app.request(path, { method, headers, body });
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) await res.body?.cancel().catch(() => undefined);
    else await res.text().catch(() => '');
    return [
      String(res.status),
      type.split(';')[0] || '-',
      `cache-control=${res.headers.get('cache-control') ?? '-'}`,
    ].join(' ');
  }

  /** Every cell's answer, `METHOD pattern cred` to its answer. */
  async function driveAll(): Promise<Map<string, string>> {
    const bodies = JSON.parse(readFileSync(BODIES, 'utf8')) as Record<string, unknown>;
    const out = new Map<string, string>();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let n = 0;
    try {
      for (const c of cells) {
        vi.setSystemTime(cellTime(n++));
        const write = WRITE_METHODS.has(c.method);
        const body = write ? JSON.stringify(bodies[c.row] ?? {}) : undefined;
        const headers = {
          ...creds[c.cred],
          ...(write ? { 'content-type': 'application/json' } : {}),
        };
        out.set(`${c.row} ${c.cred}`, await send(c.method, concretePath(c.pattern), headers, body));
      }
      vi.setSystemTime(cellTime(n++));
      out.set(
        'GET /api/no-such-route owner',
        await send('GET', '/api/no-such-route', creds.owner!, undefined),
      );
      vi.setSystemTime(cellTime(n++));
      out.set(
        'OPTIONS /api/activity preflight',
        await send(
          'OPTIONS',
          '/api/activity',
          {
            origin: 'https://client.example.invalid',
            'access-control-request-method': 'GET',
          },
          undefined,
        ),
      );
    } finally {
      quiet.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
    return out;
  }

  function readBaseline(): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of readFileSync(BASELINE, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const at = line.indexOf(' => ');
      out.set(line.slice(0, at), line.slice(at + 4));
    }
    return out;
  }

  it('every /api answer carries Cache-Control; every other answers as recorded', async () => {
    const now = await driveAll();
    expect(now.size).toBeGreaterThan(1000);
    if (RECORD) {
      writeFileSync(
        BASELINE,
        [
          '# A10 #15: every route, method and credential, its status, content type and',
          '# Cache-Control, recorded on main (v0.300.63) BEFORE the move. Written once',
          '# (A10_CACHE_SWEEP_RECORD=1); a10-cache-sweep.test.ts reads it back.',
          `# cells: ${now.size}`,
          ...[...now].map(([cell, answer]) => `${cell} => ${answer}`),
          '',
        ].join('\n'),
      );
      return;
    }
    const before = readBaseline();
    const bare = [...now]
      .filter(([cell, answer]) => isApiCell(cell) && / cache-control=-$/.test(answer))
      .map(([cell, answer]) => `${cell}: ${answer}`);
    expect(bare).toEqual([]);
    const outside = [...now].filter(([cell]) => !isApiCell(cell));
    const unreviewed = outside
      .filter(([cell, answer]) => (before.get(cell) ?? OUTSIDE_API_SINCE[cell]) !== answer)
      .map(
        ([cell, answer]) =>
          `${cell}: recorded ${before.get(cell) ?? OUTSIDE_API_SINCE[cell] ?? '(none)'}; now ${answer}`,
      );
    expect(unreviewed).toEqual([]);
    // The record holds both kinds, so a sweep that drove nothing would not
    // pass for an empty one.
    expect(outside.length).toBeGreaterThan(10);
    expect(now.size - outside.length).toBeGreaterThan(1000);
  }, 1_800_000);
});
