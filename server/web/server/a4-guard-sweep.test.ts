/**
 * The guard sweep (arch A4 step 3a): for every route of the manifest and
 * every page, every method, and every kind of credential, what the request
 * gets and what each session guard answered on the way. Recorded on main
 * (v0.300.28) BEFORE the gate resolved the login, and committed: step 3a
 * moves the login's resolution into the gate and turns each guard into a
 * reader of the bound caller, and this file must not change.
 *
 * Per request it records the answer (status, the headers a client reads,
 * the body of a refusal) and, per guard call, the guard's answer (its
 * refusal, or the login it resolved), the actor the request runs as after
 * it, and what the guard did with the request's scope (the outcome). A
 * guard that lets a login through stops the handler right there (SweepStop),
 * so nothing past the guard runs: the sweep proves the guards, and no
 * handler touches a database it does not have.
 *
 * No database: the login rows, the device tokens and the keys come from
 * stand-ins, as in the member and role sweeps.
 *
 * A second sweep (A4 step 3a audit L2), recorded on v0.300.28 too, in a
 * file of its own so the first stays byte for byte: more credentials (a
 * disabled login's cookie, a cookie from before an epoch bump, a deleted
 * login's cookie, a rotated device token presented again, an expired
 * device token, an unknown and a revoked key), and the cells of the first
 * sweep where a guard threw for want of a database, driven again with the
 * stand-ins that answer the guard's item and scope queries (READS).
 *
 * Step 3b moves guard calls to the pipeline, batch by batch (docs/actors.md):
 * a converted handler reads the caller the gate answered (ownerCaller())
 * and the gate runs the owner guard's answer itself, before the handler
 * (answerRouteCaller). Its entry in the guard log moves with it: the
 * pipeline's answer is logged as `pipeline:owner`, with the same answer,
 * actor and scope after it, at the gate. Every handler a batch converts
 * called getOwnerOr401 (the codemod converts that call only), so the two
 * recorded files compare a moved entry under that name (LEGACY_NAMES):
 * they stay byte for byte. The moved entries, as logged, are recorded in a
 * third file (`__snapshots__/a4-guard-sweep-moved.txt`), one line per cell
 * whose entry moved, so each move is on the record and reviewed.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
/** An admin that holds no Admin area (requireArea answers false). */
const LIMITED_ID = '44444444-4444-4444-8444-444444444444';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const SPACE_ID = '66666666-6666-4666-8666-666666666666';
const NODE_ID = '11111111-1111-4111-8111-111111111111';
/** A disabled login, one whose epoch moved on, and one that is gone. */
const DISABLED_ID = '77777777-7777-4777-8777-777777777777';
const BUMPED_ID = '88888888-8888-4888-8888-888888888888';
const GONE_ID = '99999999-9999-4999-8999-999999999999';

const sweepState = vi.hoisted(() => ({
  bearers: new Map<
    string,
    { userId: string; revokedAt: Date | null; expiresAt: Date; rotatedTo: string | null }
  >(),
  /** The guard calls of the request being driven. */
  log: [] as string[],
  /** The database's reads stood in (the second sweep only). */
  reads: false,
}));

const loginRow = (
  id: string,
  role: string,
  isOwner = false,
  more: { disabledAt?: Date; sessionEpoch?: number } = {},
) => ({
  id,
  email: `${role}-${id.slice(0, 4)}@example.invalid`,
  isOwner,
  displayName: `${role} ${id.slice(0, 4)}`,
  role,
  contactId: null,
  disabledAt: more.disabledAt ?? null,
  sessionEpoch: more.sessionEpoch ?? 0,
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
      : id === ADMIN_ID
        ? loginRow(ADMIN_ID, 'admin')
        : id === LIMITED_ID
          ? loginRow(LIMITED_ID, 'admin')
          : id === MEMBER_ID
            ? loginRow(MEMBER_ID, 'member')
            : id === DISABLED_ID
              ? loginRow(DISABLED_ID, 'admin', false, { disabledAt: new Date(0) })
              : id === BUMPED_ID
                ? loginRow(BUMPED_ID, 'admin', false, { sessionEpoch: 1 })
                : null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => SPACE_ID,
  loadBearerToken: async (jti: string) => sweepState.bearers.get(jti) ?? null,
  touchBearerToken: async (jti: string) => {
    sweepState.log.push(`touch ${jti.slice(0, 8)}`);
  },
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
    expiresAt: new Date(Date.now() + 90_000),
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

// The keys: verified by their token, every budget open (no rate limit
// differs between two runs of the sweep).
vi.mock('../lib/access-keys', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/access-keys')>();
  const { KEY_GRANTS, KEY_REFUSALS } = await import('./a4-guard-sweep.keys');
  const open = { ok: true as const, remaining: 1, retryAfterSec: 0 };
  return {
    ...real,
    verifyAccessKey: async (token: string) => {
      const grant = KEY_GRANTS[token];
      const refused = KEY_REFUSALS[token];
      return grant
        ? { ok: true as const, grant }
        : refused
          ? { ok: false as const, ...refused }
          : { ok: false as const, reason: 'unknown' };
    },
    rateLimitAccessKey: () => open,
    rateLimitKeySearch: () => open,
    failedKeyBudget: () => open,
    countFailedKey: () => undefined,
    touchAccessKey: () => undefined,
    auditKeyRefusal: () => undefined,
  };
});

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  // READS (the second sweep only): the database's reads a guard asks are
  // answered. A query (db.select and its chain) finds no row; a statement
  // (db.execute: the item a write names, through a share or a revision,
  // and what the login may do to it) finds one item the login may edit and
  // manage; withViewer runs its function. Writes are not stood in. Off,
  // everything is the real module's: the first sweep is unchanged.
  const none: unknown = new Proxy(() => undefined, {
    get: (_t, k) =>
      k === 'then'
        ? (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
            Promise.resolve([]).then(ok, ko)
        : () => none,
  });
  const db = new Proxy(real.db, {
    get: (t, k) => {
      if (sweepState.reads && k === 'select') return () => none;
      if (sweepState.reads && k === 'execute') {
        return async () => [
          {
            id: NODE_ID,
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
    withViewer: ((actsFor, fn) =>
      sweepState.reads ? fn() : real.withViewer(actsFor, fn)) as typeof real.withViewer,
    loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
    brainOnWorkspacesNow: async () => true,
    createHomeIntent: async () => ({ createWs: null, privateWs: null }),
  };
});
vi.mock('../lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workspaces')>()),
  requireArea: async (caller: { loginId: string }) => caller.loginId !== LIMITED_ID,
}));

/** Thrown by a guard's stand-in once it let a login through: the handler
 *  goes no further. */
class SweepStop extends Error {
  constructor() {
    super('sweep stop');
    this.name = 'SweepStop';
  }
}

/** The session guards, each wrapped to record its answer. */
const GUARDS = [
  'getOwnerForAsset',
  'getMemberForAsset',
  'getReaderForAsset',
  'getSessionUserWithSource',
  'getSessionUser',
  'requireOwner',
  'requireOwnerForRender',
  'requireOwnerWithSource',
  'getOwnerOr401',
  'getOwnerOr401WithSource',
  'getOwnerOr401WithLogin',
  'getMemberOr401',
  'getLoginOr401',
  'getChatLoginOr401',
  'getCookieUpgradeLoginOr401',
] as const;

vi.mock('../lib/auth/session', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const db = await import('@mantle/db');
  const { NextResponse } = await import('./http-compat');
  const { summarize } = await import('./a4-guard-sweep.keys');
  const after = () => {
    const actor = db.currentActor();
    const out = db.currentRequestOutcome();
    return (
      `actor=${actor ? db.actorSetting(actor) : '-'}` +
      ` out=${out ? `${out.kind}:${'why' in out ? out.why : 'writes' in out ? out.writes : ''}` : '-'}`
    );
  };
  const wrapped: Record<string, unknown> = { ...real, endLoginSessions: async () => 1 };
  // The pipeline's answer of the owner caller (A4 step 3b): logged at the
  // gate as the guard's answer was in the handler. Rows with no caller
  // are answered by their guard (no entry).
  const answer = real.answerRouteCaller as (row: { caller: string | null }) => Promise<unknown>;
  const ownerCaller = real.ownerCaller as () => unknown;
  wrapped.answerRouteCaller = async (row: { caller: string | null }) => {
    if (!row.caller) return answer(row);
    const name = `pipeline:${row.caller}`;
    let value: unknown;
    try {
      value = await answer(row);
    } catch (err) {
      const e = err as { name?: string; location?: string; message?: string };
      sweepState.log.push(
        `${name} threw ${e.name ?? '?'} ${e.location ?? (e.message ?? '').split('\n')[0]!.slice(0, 80)} ${after()}`,
      );
      throw err;
    }
    if (value instanceof NextResponse) {
      const body = await value.clone().text();
      sweepState.log.push(`${name} R${value.status} ${body.slice(0, 300)} ${after()}`);
      return value;
    }
    sweepState.log.push(`${name} ok ${summarize(ownerCaller())} ${after()}`);
    return value;
  };
  // The handler's read of it: the handler goes no further, as after a
  // guard that let a login through.
  wrapped.ownerCaller = () => {
    ownerCaller();
    throw new SweepStop();
  };
  for (const name of GUARDS) {
    const fn = real[name] as (...a: unknown[]) => Promise<unknown>;
    wrapped[name] = async (...args: unknown[]) => {
      let value: unknown;
      try {
        value = await fn(...args);
      } catch (err) {
        const e = err as { name?: string; location?: string; message?: string };
        sweepState.log.push(
          `${name} threw ${e.name ?? '?'} ${e.location ?? (e.message ?? '').split('\n')[0]!.slice(0, 80)} ${after()}`,
        );
        throw err;
      }
      if (value instanceof NextResponse) {
        const body = await value.clone().text();
        sweepState.log.push(`${name} R${value.status} ${body.slice(0, 300)} ${after()}`);
        return value;
      }
      sweepState.log.push(`${name} ok ${summarize(value)} ${after()}`);
      if (value === null) return value;
      throw new SweepStop();
    };
  }
  return wrapped;
});

import { SESSION_COOKIE_NAME, RENDER_COOKIE_NAME } from '../lib/auth-constants';
import { KEY_TOKENS } from './a4-guard-sweep.keys';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));
if (!hasManifest && process.env.CI) {
  throw new Error('server/web/server/route-manifest.gen.ts is missing: the sweep cannot run');
}

function concretePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z0-9_]+\??/g, NODE_ID).replace(/\*$/, 'a/b');
}

/** One credential: its headers, and a query string it adds. GET only for
 *  the URL-borne ones (a GET is all they ever open). */
type Cred = { name: string; headers: Record<string, string>; query?: string; getOnly?: boolean };

/** The guard each pipeline entry stands for in the two recorded files: the
 *  guard every handler a batch converted called (step 3b batch 1: the self
 *  rows, getOwnerOr401 each). */
const LEGACY_NAMES: Readonly<Record<string, string>> = { 'pipeline:owner': 'getOwnerOr401' };

/** An answer as the recorded files spell it: a moved entry under the name
 *  of the guard it replaced. Everything else is the answer as driven. */
function legacy(answer: string): string {
  return answer.replace(/\[(pipeline:[a-z]+) /g, (whole, name: string) =>
    LEGACY_NAMES[name] ? `[${LEGACY_NAMES[name]} ` : whole,
  );
}

/** The cells whose guard entry moved to the pipeline, as driven: sweep and
 *  cell to its answer. */
const moved = new Map<string, string>();
function noteMoved(sweep: string, cell: string, answer: string): string {
  if (answer.includes('[pipeline:')) moved.set(`${sweep} ${cell}`, answer);
  return legacy(answer);
}

/** The headers a client reads. */
const HEADERS = [
  'content-type',
  'cache-control',
  'location',
  'vary',
  'access-control-allow-origin',
  'retry-after',
  'www-authenticate',
];

describe.skipIf(!hasManifest)('A4 step 3a: every guard answers as on main', () => {
  const saved = {
    secret: process.env.SESSION_SECRET,
    cors: process.env.MANTLE_API_CORS_ORIGINS,
    detached: process.env.MANTLE_DETACHED_DEV,
  };
  let app: import('hono').Hono;
  let rows: Array<{ pattern: string; methods: string[] }>;
  let creds: Cred[];
  let moreCreds: Cred[];

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'a4-guard-sweep-secret-that-is-at-least-32-chars';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    const tokens = await import('../lib/auth/tokens');
    const ttl = 30 * 24 * 60 * 60;
    const cookie = (id: string) => ({
      cookie: `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(id, { ttlSeconds: ttl }).value}`,
    });
    let n = 0;
    const bearer = (
      id: string,
      revoked = false,
      row: { rotatedTo?: string; expiresAt?: Date } = {},
    ) => {
      n += 1;
      const jti = `0000000${n}-0000-4000-8000-00000000000${n}`;
      const t = tokens.buildMobileToken(id, jti, ttl, 0);
      sweepState.bearers.set(jti, {
        userId: id,
        revokedAt: revoked ? new Date() : null,
        expiresAt: row.expiresAt ?? t.expiresAt,
        rotatedTo: row.rotatedTo ?? null,
      });
      return { authorization: `Bearer ${t.value}` };
    };
    const key = (token: string) => ({ authorization: `Bearer ${token}` });
    creds = [
      { name: 'none', headers: {} },
      { name: 'owner-cookie', headers: cookie(ANCHOR_ID) },
      { name: 'admin-cookie', headers: cookie(ADMIN_ID) },
      { name: 'limited-cookie', headers: cookie(LIMITED_ID) },
      { name: 'member-cookie', headers: cookie(MEMBER_ID) },
      { name: 'admin-bearer', headers: bearer(ADMIN_ID) },
      { name: 'member-bearer', headers: bearer(MEMBER_ID) },
      { name: 'revoked-bearer', headers: bearer(ADMIN_ID, true) },
      { name: 'key-read', headers: key(KEY_TOKENS.read) },
      { name: 'key-write', headers: key(KEY_TOKENS.write) },
      { name: 'key-read-area', headers: key(KEY_TOKENS.readArea) },
      { name: 'key-write-area', headers: key(KEY_TOKENS.writeArea) },
      { name: 'key-member', headers: key(KEY_TOKENS.member) },
      {
        name: 'asset-admin',
        headers: {},
        query: `at=${encodeURIComponent(tokens.buildAssetToken(ANCHOR_ID, ADMIN_ID))}`,
        getOnly: true,
      },
      {
        name: 'asset-member',
        headers: {},
        query: `at=${encodeURIComponent(tokens.buildAssetToken(ANCHOR_ID, MEMBER_ID))}`,
        getOnly: true,
      },
      {
        name: 'render',
        headers: {
          cookie: `${RENDER_COOKIE_NAME}=${tokens.buildRenderToken({
            ownerId: ANCHOR_ID,
            actorId: ADMIN_ID,
            nodeId: NODE_ID,
          })}`,
        },
        getOnly: true,
      },
      {
        name: 'frame-ticket',
        headers: {},
        query: `t=${encodeURIComponent(tokens.buildAppFrameTicket({ ownerId: ANCHOR_ID, appId: NODE_ID, actorId: ADMIN_ID }))}`,
        getOnly: true,
      },
    ];
    // The more-credentials sweep's (made after the first sweep's, so its
    // device tokens keep their ids).
    moreCreds = [
      { name: 'disabled-cookie', headers: cookie(DISABLED_ID) },
      { name: 'bumped-cookie', headers: cookie(BUMPED_ID) },
      { name: 'gone-cookie', headers: cookie(GONE_ID) },
      {
        name: 'rotated-bearer',
        headers: bearer(ADMIN_ID, true, { rotatedTo: '00000009-0000-4000-8000-000000000009' }),
      },
      { name: 'expired-bearer', headers: bearer(MEMBER_ID, false, { expiresAt: new Date(0) }) },
      { name: 'key-unknown', headers: key(KEY_TOKENS.unknown) },
      { name: 'key-revoked', headers: key(KEY_TOKENS.revoked) },
    ];
    const { createApp } = await import('./app');
    app = await createApp();
    const { routeManifest } = await import('./route-manifest.gen');
    const [{ SHARE_PAGES }, { PRINT_PAGES }] = await Promise.all([
      import('./pages/share'),
      import('./pages/print'),
    ]);
    rows = [
      ...routeManifest.map((e) => ({ pattern: e.pattern, methods: [...e.methods] })),
      ...[...SHARE_PAGES, ...PRINT_PAGES].map((p) => ({
        pattern: p.pattern,
        methods: [...p.methods],
      })),
    ].sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  }, 60_000);

  afterAll(() => {
    for (const [k, v] of [
      ['SESSION_SECRET', saved.secret],
      ['MANTLE_API_CORS_ORIGINS', saved.cors],
      ['MANTLE_DETACHED_DEV', saved.detached],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function drive(method: string, path: string, cred: Cred): Promise<string> {
    sweepState.log.length = 0;
    const url = cred.query ? `${path}${path.includes('?') ? '&' : '?'}${cred.query}` : path;
    const res = await app.request(url, {
      method,
      headers: { ...cred.headers, 'content-type': 'application/json' },
      body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
    });
    const parts = [String(res.status)];
    for (const h of HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) parts.push(`${h}=${h === 'location' ? v.replace(/\?.*$/, '?…') : v}`);
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      await res.body?.cancel().catch(() => undefined);
      parts.push('stream');
    } else {
      const text = await res.text();
      // A refusal's body, and a guarded answer's: what the guard sent. A
      // route no guard serves keeps its own body (a version, a page) out.
      if (type.includes('json') && (sweepState.log.length > 0 || res.status >= 400)) {
        parts.push(text.slice(0, 300));
      }
    }
    for (const line of sweepState.log) parts.push(`[${line}]`);
    return parts.join(' ');
  }

  it('answers every route, method and credential as recorded on main', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const answers = new Map<string, string>();
    const lines: string[] = [];
    let driven = 0;
    try {
      for (const row of rows) {
        const path = concretePath(row.pattern);
        const methods = row.methods.includes('GET') ? [...row.methods, 'HEAD'] : row.methods;
        for (const method of methods) {
          if (method === 'OPTIONS') continue;
          const cells: string[] = [];
          for (const cred of creds) {
            if (cred.getOnly && method !== 'GET') continue;
            const answer = noteMoved(
              'first',
              `${method} ${row.pattern} ${cred.name}`,
              await drive(method, path, cred),
            );
            driven += 1;
            let id = answers.get(answer);
            if (!id) {
              id = `a${answers.size + 1}`;
              answers.set(answer, id);
            }
            cells.push(`${cred.name}=${id}`);
          }
          lines.push(`${method} ${row.pattern}: ${cells.join(' ')}`);
        }
      }
    } finally {
      quiet.mockRestore();
      warn.mockRestore();
    }
    const table = [...answers].map(([answer, id]) => `${id} ${answer}`);
    expect(driven).toBeGreaterThan(10_000);
    await expect(
      ['# answers', ...table, '', '# routes', ...lines, ''].join('\n'),
    ).toMatchFileSnapshot('./__snapshots__/a4-guard-sweep.txt');
  }, 1_200_000);

  /** Every route and method (OPTIONS aside), as the first sweep walks them. */
  function* cellsOf(
    list: Cred[],
  ): Generator<{ line: string; method: string; path: string; cred: Cred }> {
    for (const row of rows) {
      const path = concretePath(row.pattern);
      const methods = row.methods.includes('GET') ? [...row.methods, 'HEAD'] : row.methods;
      for (const method of methods) {
        if (method === 'OPTIONS') continue;
        for (const cred of list) {
          if (cred.getOnly && method !== 'GET') continue;
          yield { line: `${method} ${row.pattern}`, method, path, cred };
        }
      }
    }
  }

  it('answers more credentials, and the cells that wanted a database, as recorded on main', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const answers = new Map<string, string>();
    const idOf = (answer: string) => {
      let id = answers.get(answer);
      if (!id) {
        id = `a${answers.size + 1}`;
        answers.set(answer, id);
      }
      return id;
    };
    const more = new Map<string, string[]>();
    const again = new Map<string, string[]>();
    const NO_DB = 'DATABASE_URL must be set';
    let noDbBefore = 0;
    let noDbAfter = 0;
    // The clock stands still, hours past the first sweep's rate-limit
    // windows: every limit this sweep meets starts empty and answers the
    // same Retry-After, whichever sweep ran first.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
    try {
      sweepState.reads = true;
      for (const { line, method, path, cred } of cellsOf(moreCreds)) {
        const answer = noteMoved('more', `${line} ${cred.name}`, await drive(method, path, cred));
        if (answer.includes(NO_DB)) noDbAfter += 1;
        more.set(line, [...(more.get(line) ?? []), `${cred.name}=${idOf(answer)}`]);
      }
      // The first sweep's cells where a guard threw for want of a
      // database, driven again with the reads stood in.
      for (const { line, method, path, cred } of cellsOf(creds)) {
        sweepState.reads = false;
        const before = await drive(method, path, cred);
        if (!before.includes(NO_DB)) continue;
        noDbBefore += 1;
        sweepState.reads = true;
        const answer = noteMoved('again', `${line} ${cred.name}`, await drive(method, path, cred));
        if (answer.includes(NO_DB)) noDbAfter += 1;
        again.set(line, [...(again.get(line) ?? []), `${cred.name}=${idOf(answer)}`]);
      }
    } finally {
      vi.useRealTimers();
      sweepState.reads = false;
      quiet.mockRestore();
      warn.mockRestore();
    }
    const table = [...answers].map(([answer, id]) => `${id} ${answer}`);
    const lines = (m: Map<string, string[]>) =>
      [...m].map(([l, cells]) => `${l}: ${cells.join(' ')}`);
    expect(more.size).toBeGreaterThan(500);
    await expect(
      [
        '# answers',
        ...table,
        '',
        `# cells that wanted a database: ${noDbBefore} in the first sweep; ${noDbAfter} still do with the reads stood in`,
        '',
        '# more credentials',
        ...lines(more),
        '',
        '# the first sweep, its cells that wanted a database, with the reads stood in',
        ...lines(again),
        '',
      ].join('\n'),
    ).toMatchFileSnapshot('./__snapshots__/a4-guard-sweep-more.txt');
  }, 1_200_000);

  it('records every guard entry that moved to the pipeline (A4 step 3b)', async () => {
    // After both sweeps (the tests of this file run in order). Each line is
    // a cell whose handler reads the caller the gate answered: its answer as
    // driven, the entry logged at the gate (pipeline:owner) where the guard's
    // was. The recorded files hold the same answer under the guard's name.
    expect(moved.size).toBeGreaterThan(0);
    const answers = new Map<string, string>();
    const lines = [...moved].map(([cell, answer]) => {
      let id = answers.get(answer);
      if (!id) {
        id = `m${answers.size + 1}`;
        answers.set(answer, id);
      }
      return `${cell}=${id}`;
    });
    await expect(
      [
        '# answers',
        ...[...answers].map(([answer, id]) => `${id} ${answer}`),
        '',
        `# cells whose guard entry moved to the pipeline: ${moved.size}`,
        ...lines,
        '',
      ].join('\n'),
    ).toMatchFileSnapshot('./__snapshots__/a4-guard-sweep-moved.txt');
  });
});
