/**
 * The error sweep (A10 part 2, fold 2: one error answer;
 * docs/request-plumbing.md). Every route of the files fold 2 moves (a
 * catch that put a caught error's text in a reply, the isScopeWriteRefusal
 * re-throws, the treeErrorResponse catches; ERROR_FILES below), every
 * method, as the owner, with the route's valid body (the body sweep's,
 * a10-body-sweep.bodies.json), and a forced failure: once the handler has
 * read its caller, every use of the database throws the fault of the cell:
 *
 *  - plain:      a plain Error;
 *  - db:         a drizzle query error over a Postgres error (its text
 *                carries the SQL);
 *  - scope:      the database's workspace refusal (42501, one of its own
 *                messages; isScopeWriteRefusal);
 *  - busy:       BusyError (another write held the rows);
 *  - tree-*:     TreeError not-found, conflict, invalid, gone, and
 *                TreeVisibilityError (a write that changes who can see).
 *
 * Per cell: status, content type, a redirect's location and the body (cut
 * at 400 characters). Recorded BEFORE the move
 * (__snapshots__/a10-error-sweep.txt, written once with
 * A10_ERROR_SWEEP_RECORD=1); after it every cell answers as recorded or is
 * a named change (__snapshots__/a10-error-sweep-changes.txt, changeKind).
 * The stand-ins are the body sweep's (a10-body-sweep.test.ts).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** The forced failure: on once the handler read its caller. */
const faults = vi.hoisted(() => ({
  inHandler: false,
  make: null as null | (() => unknown),
}));

// The readers of the caller (session-guards.mjs): a handler reads one
// first, so the fault is on from there (the gate's own reads answer).
vi.mock('../lib/auth/session', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const { CALLER_READERS } = await import('../../../eslint-rules/session-guards.mjs');
  const out: Record<string, unknown> = { ...real };
  for (const name of CALLER_READERS as readonly string[]) {
    const fn = real[name] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof fn !== 'function') continue;
    out[name] = (...a: unknown[]) => {
      faults.inHandler = true;
      return fn(...a);
    };
  }
  return out;
});

const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const SPACE_ID = '66666666-6666-4666-8666-666666666666';

const loginRow = (id: string, role: string, isOwner = false) => ({
  id,
  email: `${role}-${id.slice(0, 4)}@example.invalid`,
  isOwner,
  displayName: `${role} ${id.slice(0, 4)}`,
  role,
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
  mcpLoginEnabled: async () => false,
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
      // In the handler, a forced failure: every use of the database throws it.
      if (faults.inHandler && faults.make) throw faults.make();
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
    withViewer: ((_actsFor, fn) => {
      if (faults.inHandler && faults.make) throw faults.make();
      return fn();
    }) as typeof real.withViewer,
    loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
    brainOnWorkspacesNow: async () => true,
    createHomeIntent: async () => ({ createWs: null, privateWs: null }),
  };
});
vi.mock('../lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workspaces')>()),
  requireArea: async () => true,
}));

import { SESSION_COOKIE_NAME } from '../lib/auth-constants';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));
if (!hasManifest && process.env.CI) {
  throw new Error('server/web/server/route-manifest.gen.ts is missing: the sweep cannot run');
}
const RECORD = process.env.A10_ERROR_SWEEP_RECORD === '1';
const BASELINE = join(here, '__snapshots__/a10-error-sweep.txt');
const BODIES = join(here, '__snapshots__/a10-body-sweep.bodies.json');
const NOW = new Date('2026-10-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const SAMPLE_ID = '11111111-1111-4111-8111-111111111111';

/**
 * The route files fold 2 moves, fixed when the baseline was recorded: the
 * files whose catch put a caught error's text in a reply
 * (errorTextReplies, eslint-rules/route-plumbing.mjs), and the files with
 * an isScopeWriteRefusal re-throw or a treeErrorResponse catch.
 */
const ERROR_FILES: readonly string[] = JSON.parse(
  readFileSync(join(here, '__snapshots__/a10-error-sweep.files.json'), 'utf8'),
) as string[];

const FAULTS = [
  'plain',
  'db',
  'scope',
  'busy',
  'tree-not-found',
  'tree-conflict',
  'tree-invalid',
  'tree-gone',
  'tree-visibility',
] as const;
type Fault = (typeof FAULTS)[number];

async function faultOf(kind: Fault): Promise<() => unknown> {
  const { BusyError } = await import('@mantle/db');
  const { TreeError, TreeVisibilityError } = await import('@mantle/content/tree');
  switch (kind) {
    case 'plain':
      return () => new Error('sweep: a plain error with private detail');
    case 'db':
      return () =>
        Object.assign(
          new Error('Failed query: select "secret" from "nodes" where "id" = $1\nparams: sweep'),
          {
            name: 'DrizzleQueryError',
            cause: Object.assign(new Error('column "secret" does not exist'), {
              code: '42703',
              severity: 'ERROR',
            }),
          },
        );
    case 'scope':
      return () =>
        Object.assign(new Error('not allowed to change this item'), {
          code: '42501',
          severity: 'ERROR',
        });
    case 'busy':
      return () => new BusyError();
    case 'tree-not-found':
      return () => new TreeError('not-found', 'sweep: folder not found');
    case 'tree-conflict':
      return () => new TreeError('conflict', 'sweep: a folder of that name exists');
    case 'tree-invalid':
      return () => new TreeError('invalid', 'sweep: not a valid name');
    case 'tree-gone':
      return () => new TreeError('gone', 'sweep: folder shares have ended');
    case 'tree-visibility':
      return () =>
        new TreeVisibilityError({
          changes: [{ workspaceId: SAMPLE_ID, gained: 1, lost: 0 }],
          total: 1,
        } as never);
  }
}

/** The manifest pattern of a route file (app/api/x/[id]/route.ts). */
function patternOf(file: string): string {
  return file
    .replace(/^server\/web\/app/, '')
    .replace(/\/route\.ts$/, '')
    .replace(/\[\[?\.\.\.[^\]]+\]\]?/g, '*')
    .replace(/\[([^\]]+)\]/g, ':$1');
}

function concretePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z0-9_]+\??/g, SAMPLE_ID).replace(/\*$/, 'a/b');
}

describe.skipIf(!hasManifest)('A10 part 2 fold 2: every moved route answers a failure', () => {
  const saved = {
    secret: process.env.SESSION_SECRET,
    db: process.env.DATABASE_URL,
    cors: process.env.MANTLE_API_CORS_ORIGINS,
    detached: process.env.MANTLE_DETACHED_DEV,
  };
  const realFetch = globalThis.fetch;
  let app: import('hono').Hono;
  let owner: Record<string, string> = {};
  const cells: Array<{ method: string; pattern: string }> = [];
  const pools = new Map<string, unknown>();
  const POOLS = ['__mantleDb', '__mantleSql', '__mantleViewerDbs'] as const;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'a10-error-sweep-secret-that-is-at-least-32-chars';
    delete process.env.DATABASE_URL;
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    globalThis.fetch = (async () => {
      throw new Error('sweep: no network');
    }) as typeof fetch;
    // The pools @mantle/db opens on first use: in the handler, under a
    // fault, reaching one throws the fault (the helpers that open a pool
    // themselves, not through \`db\`).
    for (const name of POOLS) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          if (faults.inHandler && faults.make) throw faults.make();
          return pools.get(name);
        },
        set(v: unknown) {
          pools.set(name, v);
        },
      });
    }
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW.getTime() - 2 * 365 * DAY));
    const tokens = await import('../lib/auth/tokens');
    owner = {
      cookie: `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(ANCHOR_ID, { ttlSeconds: 20 * 365 * 86_400 }).value}`,
    };
    const { createApp } = await import('./app');
    app = await createApp();
    const { routeManifest } = await import('./route-manifest.gen');
    const wanted = new Set(ERROR_FILES.map(patternOf));
    for (const e of [...routeManifest].sort((a, b) => (a.pattern < b.pattern ? -1 : 1))) {
      if (!wanted.has(e.pattern)) continue;
      wanted.delete(e.pattern);
      for (const method of e.methods) cells.push({ method, pattern: e.pattern });
    }
    expect([...wanted], 'ERROR_FILES names a file the manifest does not serve').toEqual([]);
  }, 120_000);

  afterAll(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    for (const name of POOLS) {
      delete (globalThis as Record<string, unknown>)[name];
    }
    for (const [k, v] of [
      ['SESSION_SECRET', saved.secret],
      ['DATABASE_URL', saved.db],
      ['MANTLE_API_CORS_ORIGINS', saved.cors],
      ['MANTLE_DETACHED_DEV', saved.detached],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function send(method: string, pattern: string, body: unknown): Promise<string> {
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const res = await app.request(concretePath(pattern), {
      method,
      headers: { ...owner, 'content-type': 'application/json' },
      body: hasBody ? JSON.stringify(body ?? {}) : undefined,
    });
    const type = res.headers.get('content-type') ?? '';
    const parts = [String(res.status), type.split(';')[0] || '-'];
    const location = res.headers.get('location');
    if (location) parts.push(`location=${location}`);
    if (type.includes('text/event-stream')) {
      await res.body?.cancel().catch(() => undefined);
      parts.push('stream');
    } else {
      const text = await res.text();
      parts.push(text.length > 400 ? `${text.slice(0, 400)}…(${text.length})` : text);
    }
    return parts.join(' ');
  }

  async function driveAll(): Promise<Map<string, string>> {
    const bodies = JSON.parse(readFileSync(BODIES, 'utf8')) as Record<string, unknown>;
    const out = new Map<string, string>();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // A handler's fire-and-forget write (an ingest record, a touch) meets the
    // fault too, after the answer: its rejection is the fault, not a bug.
    const listeners = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', () => undefined);
    let n = 0;
    try {
      for (const c of cells) {
        for (const kind of FAULTS) {
          vi.setSystemTime(new Date(NOW.getTime() + n++ * DAY));
          faults.make = await faultOf(kind);
          faults.inHandler = false;
          try {
            out.set(
              `${c.method} ${c.pattern} ${kind}`,
              await send(c.method, c.pattern, bodies[`${c.method} ${c.pattern}`]),
            );
          } finally {
            faults.make = null;
            faults.inHandler = false;
          }
        }
      }
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 100));
      process.removeAllListeners('unhandledRejection');
      for (const l of listeners) process.on('unhandledRejection', l);
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

  it('answers every forced failure as recorded before the move', async () => {
    const now = await driveAll();
    expect(now.size).toBeGreaterThan(500);
    if (RECORD) {
      writeFileSync(
        BASELINE,
        [
          '# A10 part 2 fold 2: every route of the files fold 2 moves, every method, as the',
          '# owner with its valid body, and a forced failure at the database. Recorded BEFORE',
          '# the move (A10_ERROR_SWEEP_RECORD=1); a10-error-sweep.test.ts reads it back and',
          '# holds every cell to it, or to a named change.',
          `# cells: ${now.size}`,
          ...[...now].map(([cell, answer]) => `${cell} => ${answer}`),
          '',
        ].join('\n'),
      );
      return;
    }
    const before = readBaseline();
    expect([...now.keys()].sort()).toEqual([...before.keys()].sort());
    const changed = [...now].filter(([cell, answer]) => before.get(cell) !== answer);
    const unnamed = changed
      .filter(([cell, answer]) => changeKind(cell, before.get(cell)!, answer) === null)
      .map(([cell, answer]) => `${cell}: before ${before.get(cell)}; now ${answer}`);
    expect(unnamed).toEqual([]);
    const kinds = new Map<string, number>();
    for (const [cell, answer] of changed) {
      const k = changeKind(cell, before.get(cell)!, answer)!;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    await expect(
      [
        '# A10 part 2 fold 2: the cells that answer otherwise than before the move, each',
        '# with its named kind (changeKind, a10-error-sweep.test.ts), its answer before and',
        '# now. Every other cell of a10-error-sweep.txt answers byte for byte as recorded.',
        ...[...kinds].map(([k, n]) => `# ${k}: ${n} cells`),
        ...changed.flatMap(([cell, answer]) => [
          `${cell} [${changeKind(cell, before.get(cell)!, answer)}]`,
          `  before ${before.get(cell)}`,
          `  now    ${answer}`,
        ]),
        '',
      ].join('\n'),
    ).toMatchFileSnapshot('./__snapshots__/a10-error-sweep-changes.txt');
  }, 1_800_000);
});

/** The one opaque answer to an error no table names (answerAppError). */
const OPAQUE = '500 application/json {"error":"internal error"}';

/** The table's answer to each domain fault (@mantle/std domain-errors.ts,
 *  the mapper for the workspace refusal, answerAppError for busy): the
 *  start of the status and a piece of the body. */
const TABLE_ANSWER: Readonly<Partial<Record<string, [string, string]>>> = {
  'tree-not-found': ['404 ', '"error":"sweep: folder not found"'],
  'tree-conflict': ['409 ', '"error":"sweep: a folder of that name exists"'],
  'tree-invalid': ['400 ', '"error":"sweep: not a valid name"'],
  'tree-gone': ['410 ', '"code":"gone"'],
  'tree-visibility': ['409 ', '"error":"visibility"'],
  busy: ['409 ', '"error":"Another change to this item is under way'],
  scope: ['403 ', '"reason":"item-workspace"'],
};

/**
 * The named changes of fold 2, by cell (`METHOD pattern fault`), its answer
 * before and now (null: none names it, and the test fails):
 *
 *  - opaque-500: a plain error or a database error, whose text the route
 *    put in its reply (mostly as a 400), answers the one opaque 500 (the
 *    text goes to the server log);
 *  - redirect-no-text: the same on a route that answers with a redirect:
 *    the redirect no longer carries the error's text;
 *  - domain-by-table: a domain error (a TreeError, TreeVisibilityError,
 *    the workspace refusal, busy) answers as the one table says, where the
 *    route's hand catch gave it another status (its text as a 400, or the
 *    opaque 500 of a route that mapped none).
 */
function changeKind(cell: string, before: string, now: string): string | null {
  const fault = cell.slice(cell.lastIndexOf(' ') + 1);
  const table = TABLE_ANSWER[fault];
  if (table) return now.startsWith(table[0]) && now.includes(table[1]) ? 'domain-by-table' : null;
  if (fault !== 'plain' && fault !== 'db') return null;
  if (now === OPAQUE) return 'opaque-500';
  if (/ location=/.test(before) && / location=/.test(now) && !/sweep|secret|Failed/.test(now)) {
    return 'redirect-no-text';
  }
  return null;
}
